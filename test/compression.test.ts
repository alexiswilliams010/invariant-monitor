import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallFrame } from "../src/collection/types.js";
import {
  CallSequenceCompressor,
  type RepeatEvidence,
  type SequenceNode,
} from "../src/decoding/compression.js";

const a = `0x${"aa".repeat(20)}` as const;
const b = `0x${"bb".repeat(20)}` as const;
const c = `0x${"cc".repeat(20)}` as const;
function call(id: string, overrides: Partial<CallFrame> = {}): CallFrame {
  return {
    id,
    parentId: id === "root" ? null : "root",
    traceAddress: [],
    type: "CALL",
    from: a,
    to: b,
    storageContext: b,
    input: "0x12345678",
    output: "0x",
    value: "0",
    reverted: false,
    readOnly: false,
    ...overrides,
  };
}

function expand(
  nodes: readonly SequenceNode[],
  repeats: readonly RepeatEvidence[],
): string[] {
  return nodes.flatMap((node) =>
    node.kind === "call"
      ? [node.callId, ...expand(node.children, repeats)]
      : repeats.find((repeat) => repeat.id === node.id)!.iterations.flat(),
  );
}

function compress(calls: readonly CallFrame[]) {
  const result = new CallSequenceCompressor().compress(calls);
  assert.deepEqual(
    expand(result.sequence, result.repeats),
    calls.map((call) => call.id),
  );
  assert.doesNotMatch(JSON.stringify(result.sequence), /0x[0-9a-f]/i);
  return result;
}

test("twenty consecutive calls become one repeated body with byte-level argument/output differences marked", () => {
  const calls = [
    call("root"),
    ...Array.from({ length: 20 }, (_, i) =>
      call(String(i), {
        input: `0x12345678${i.toString(16).padStart(2, "0")}`,
        output: i ? "0x01" : "0x",
      }),
    ),
  ];
  const result = compress(calls);
  const root = result.sequence[0]!;
  assert.equal(root.kind, "call");
  if (root.kind !== "call") return;
  assert.equal(root.children.length, 1);
  const group = root.children[0]!;
  assert.equal(group.kind, "repeat");
  if (group.kind !== "repeat") return;
  assert.equal(group.count, 20);
  assert.equal(group.diffArgs, true);
  assert.equal(group.diffReturns, true);
  assert.equal(group.body.length, 1);
});

test("matching pairs repeat without combining or redirecting their distinct edges", () => {
  const calls = [
    call("root"),
    call("0"),
    call("1", { from: b, to: c, storageContext: c }),
    call("2"),
    call("3", { from: b, to: c, storageContext: c }),
  ];
  const result = compress(calls);
  assert.deepEqual(result.repeats[0]?.iterations, [
    ["0", "1"],
    ["2", "3"],
  ]);
  const root = result.sequence[0]!;
  if (root.kind !== "call" || root.children[0]?.kind !== "repeat")
    throw new Error("Missing repeated pair");
  assert.deepEqual(
    root.children[0].body.map((node) =>
      node.kind === "call" ? node.callId : null,
    ),
    ["0", "1"],
  );
});

test("address, storage context, selector, call type, value and outcome differences prevent grouping", () => {
  for (const overrides of [
    { from: c },
    { to: c },
    { storageContext: c },
    { input: "0x87654321" },
    { type: "DELEGATECALL" },
    { value: "1" },
    { reverted: true },
    { readOnly: true },
  ] as Partial<CallFrame>[]) {
    assert.equal(
      compress([call("root"), call("0"), call("1", overrides)]).repeats.length,
      0,
    );
  }
  assert.equal(
    compress([call("root"), call("0"), call("1", { to: c }), call("2")]).repeats
      .length,
    0,
  );
});

test("identical nested shapes repeat while different callees or child counts stay distinct", () => {
  const calls = [
    call("root"),
    call("0"),
    call("0.0", { parentId: "0", from: b, to: c }),
    call("1"),
    call("1.0", { parentId: "1", from: b, to: c }),
  ];
  assert.deepEqual(compress(calls).repeats[0]?.iterations, [
    ["0", "0.0"],
    ["1", "1.0"],
  ]);
  assert.equal(
    compress([
      ...calls.slice(0, -1),
      call("1.0", { parentId: "1", from: b, to: a }),
    ]).repeats.length,
    0,
  );
  assert.equal(compress(calls.slice(0, -1)).repeats.length, 0);
});

test("nested repeats retain complete provenance without orphaned repeat records", () => {
  const calls = [
    call("root"),
    ...["0", "1"].flatMap((id) => [
      call(id),
      call(`${id}.0`, { parentId: id }),
      call(`${id}.1`, { parentId: id }),
    ]),
  ];
  const result = compress(calls);
  assert.equal(result.repeats.length, 2);
  assert.equal(
    result.repeats.some((repeat) => repeat.id.startsWith("repeat:1.0:")),
    false,
  );
  assert.deepEqual(result.repeats[0]?.iterations, [
    ["0", "0.0", "0.1"],
    ["1", "1.0", "1.1"],
  ]);
});

test("creation and destruction are never folded into loops", () => {
  for (const type of ["CREATE", "CREATE2", "SELFDESTRUCT"] as const) {
    assert.equal(
      compress([call("root"), call("0", { type }), call("1", { type })]).repeats
        .length,
      0,
    );
  }
});

test("invalid trees and invalid search limits fail instead of silently dropping calls", () => {
  const compressor = new CallSequenceCompressor();
  for (const calls of [
    [],
    [call("0")],
    [call("root"), call("root")],
    [call("root"), call("0"), call("1"), call("0.0", { parentId: "0" })],
  ])
    assert.throws(() => compressor.compress(calls));
  assert.throws(() => new CallSequenceCompressor(0));
  const pair = [
    call("root"),
    call("0"),
    call("1", { to: c }),
    call("2"),
    call("3", { to: c }),
  ];
  assert.equal(new CallSequenceCompressor(1).compress(pair).repeats.length, 0);
});

test("repeated bodies compress consecutive inner runs without crossing intervening calls", () => {
  const calls = [
    call("root"),
    ...Array.from({ length: 3 }, (_, iteration) =>
      Array.from({ length: 5 }, (_, offset) =>
        call(`${iteration}.${offset}`, {
          to: offset === 1 ? c : b,
          storageContext: offset === 1 ? c : b,
          input: `0x12345678${(iteration * 5 + offset).toString(16).padStart(2, "0")}`,
          output: `0x${offset.toString(16).padStart(2, "0")}`,
        }),
      ),
    ).flat(),
  ];
  const result = compress(calls);
  const root = result.sequence[0]!;
  if (root.kind !== "call") throw new Error("Missing root");
  const outer = root.children[0]!;
  if (outer.kind !== "repeat") throw new Error("Missing outer repeat");
  assert.equal(outer.count, 3);
  assert.equal(outer.body.length, 3);
  assert.deepEqual(
    outer.body
      .slice(0, 2)
      .map((node) => (node.kind === "call" ? node.callId : null)),
    ["0.0", "0.1"],
  );
  const inner = outer.body[2]!;
  if (inner.kind !== "repeat") throw new Error("Missing inner repeat");
  assert.equal(inner.count, 3);
  assert.equal(inner.diffArgs, true);
  assert.equal(inner.diffReturns, true);
  assert.equal(result.repeats.length, 2);
  for (const node of [outer, inner]) {
    const evidence = result.repeats.find((item) => item.id === node.id)!;
    assert.deepEqual(expand(node.body, result.repeats), evidence.iterations[0]);
  }
  assert.deepEqual(result.repeats[1]!.iterations, [["0.2"], ["0.3"], ["0.4"]]);
});
