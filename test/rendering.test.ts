import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { runRenderCli } from "../src/rendering/cli.js";
import { D2SequenceRenderer } from "../src/rendering/renderer.js";
import {
  readDiagram,
  SequenceDiagramBuilder,
} from "../src/rendering/sequence.js";

function fixture() {
  const call = (
    id: string,
    parentId: string | null,
    from: string,
    to: string,
    action: string,
  ) => ({
    id,
    parentId,
    from,
    to,
    storageContext: to,
    action,
    kind: "CALL",
    valueWei: "0",
    reverted: false,
  });
  return {
    schemaVersion: 3,
    calls: [
      call("root", null, "A", "B", "execute"),
      call("child", "root", "B", "C", "swap"),
    ],
    sequence: [
      {
        kind: "call",
        callId: "root",
        children: [
          {
            kind: "repeat",
            id: "repeat",
            count: 20,
            diffArgs: true,
            diffReturns: false,
            body: [{ kind: "call", callId: "child", children: [] }],
          },
        ],
      },
    ],
  };
}

test("sequence source preserves nested endpoints and repeated bodies", () => {
  const source = new SequenceDiagramBuilder().build(readDiagram(fixture()));
  assert.match(source, /a: "A"[\s\S]*b: "B"[\s\S]*a -> b: "execute"/);
  assert.match(source, /a -> b: "swap"/);
  assert.equal(source.match(/a -> b/g)?.length, 2);
  assert.match(source, /"x20 · diff args"/);
  assert.equal(source.match(/: "swap"/g)?.length, 1);
});

test("renderer rejects corrupt sequence references and repeat counts", () => {
  const wrongVersion = fixture();
  wrongVersion.schemaVersion = 2;
  assert.throws(() => readDiagram(wrongVersion), /schema version/);
  const wrongParent = fixture();
  wrongParent.calls[1]!.parentId = null;
  assert.throws(() => readDiagram(wrongParent), /reference mismatch/);
  const missing = fixture();
  missing.calls.pop();
  assert.throws(() => readDiagram(missing), /reference mismatch/);
  const badRepeat = fixture();
  badRepeat.sequence[0]!.children[0]!.count = 1;
  assert.throws(() => readDiagram(badRepeat), /repeat block/);
  const duplicate = fixture();
  duplicate.calls.push(duplicate.calls[0]!);
  assert.throws(() => readDiagram(duplicate), /Duplicate/);
});

test("D2 compiles literal labels and exports JPEG at the requested scale", async () => {
  const value = fixture();
  value.calls[1]!.action = 'swap "quoted" ${malicious} \\ 0xabcdef';
  const renderer = new D2SequenceRenderer();
  const input = readDiagram(value);
  const small = await renderer.render(input, { quality: 40, scale: 0.5 });
  const large = await renderer.render(input, { quality: 95, scale: 1 });
  assert.match(large.svg, /<svg/);
  assert.doesNotMatch(large.source, /0xabcdef|\$\{/);
  assert.match(large.source, /bytes/);
  const metadata = await sharp(large.jpeg).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, large.width);
  assert.ok(Math.abs(large.width - small.width * 2) <= 1);
  assert.ok(Math.abs(large.height - small.height * 2) <= 1);
  assert.ok(large.jpeg.length > small.jpeg.length);
  await assert.rejects(
    renderer.render(input, { quality: 101, scale: 1 }),
    /quality/,
  );
});

test("selfdestruct has no synthetic return and failed creations stay distinct", () => {
  const value = fixture();
  value.calls[1]!.kind = "SELFDESTRUCT";
  const source = new SequenceDiagramBuilder().build(readDiagram(value));
  assert.match(source, /a -> b: "swap"/);
  assert.equal(source.match(/style.stroke-dash/g)?.length ?? 0, 0);
  const created = { ...value.calls[1]!, kind: "CREATE", to: "contract" };
  const input = readDiagram({
    schemaVersion: 3,
    calls: [value.calls[0], created, { ...created, id: "second" }],
    sequence: [
      {
        kind: "call",
        callId: "root",
        children: ["child", "second"].map((callId) => ({
          kind: "call",
          callId,
          children: [],
        })),
      },
    ],
  });
  assert.equal(
    new SequenceDiagramBuilder().build(input).match(/: "contract(?:_2)?"/g)
      ?.length,
    2,
  );
});

test("render CLI preserves existing outputs and cleans up failed exports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invariant-render-"));
  try {
    const input = join(dir, "input.json");
    const output = join(dir, "diagram");
    await writeFile(input, JSON.stringify(fixture()));
    await writeFile(`${output}.svg`, "existing");
    await assert.rejects(
      runRenderCli(["--input", input, "--output", output]),
      /EEXIST/,
    );
    assert.equal(await readFile(`${output}.svg`, "utf8"), "existing");
    assert.deepEqual((await readdir(dir)).sort(), [
      "diagram.svg",
      "input.json",
    ]);
    await assert.rejects(
      runRenderCli([
        "--input",
        input,
        "--output",
        join(dir, "invalid"),
        "--scale",
        "0",
      ]),
      /scale/,
    );
    assert.deepEqual((await readdir(dir)).sort(), [
      "diagram.svg",
      "input.json",
    ]);
    assert.match(await runRenderCli(["--help"]), /quality/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forwarding uses implementation names without merging separate proxies", () => {
  const root = fixture().calls[0]!;
  const forwarded = (id: string, proxy: string) => [
    {
      ...root,
      id,
      parentId: "root",
      from: "B",
      to: proxy,
      storageContext: proxy,
      action: "call",
    },
    {
      ...root,
      id: `${id}.0`,
      parentId: id,
      from: proxy,
      to: "Implementation",
      storageContext: proxy,
      kind: "DELEGATECALL",
      action: "swap",
    },
  ];
  const input = {
    schemaVersion: 3,
    calls: [root, ...forwarded("one", "ProxyA"), ...forwarded("two", "ProxyB")],
    sequence: [
      {
        kind: "call",
        callId: "root",
        children: ["one", "two"].map((id) => ({
          kind: "call",
          callId: id,
          children: [{ kind: "call", callId: `${id}.0`, children: [] }],
        })),
      },
    ],
  };
  const source = new SequenceDiagramBuilder().build(readDiagram(input));
  assert.match(source, /b: "Implementation"/);
  assert.match(source, /b: "Implementation_2"/);
  assert.match(source, /a -> b: "swap"/);
  assert.match(source, /a -> b: "swap"/);
  assert.equal(source.match(/ -> /g)?.length, 3);
  assert.doesNotMatch(source, /ProxyA|ProxyB/);
  input.calls[2]!.storageContext = "DifferentContext";
  const unmatched = new SequenceDiagramBuilder().build(readDiagram(input));
  assert.match(unmatched, /ProxyA/);
  assert.equal(unmatched.match(/ -> /g)?.length, 4);
});

test("distinct named actions and ordinary calls are not treated as forwarding", () => {
  for (const kind of ["CALL", "DELEGATECALL"]) {
    const value = fixture();
    value.calls[1]!.kind = kind;
    value.calls[1]!.storageContext = "B";
    const source = new SequenceDiagramBuilder().build(readDiagram(value));
    assert.match(source, /"execute"/);
    assert.match(source, /"swap"/);
  }
});
