import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { runAnalyzeCli } from "../src/pipeline/cli.js";
import {
  TransactionPipeline,
  reportFiles,
  type ReportFiles,
} from "../src/pipeline/transaction.js";
import { TransactionDecoder } from "../src/decoding/decoder.js";
import { StandardTokenInterpreter } from "../src/interpretation/tokens.js";
import { SequenceDiagramBuilder } from "../src/rendering/sequence.js";
import type { TransactionEvidence } from "../src/collection/types.js";
const hash = `0x${"11".repeat(32)}` as const;
const from = `0x${"aa".repeat(20)}` as const;
const to = `0x${"bb".repeat(20)}` as const;
function evidence(): TransactionEvidence {
  return {
    schemaVersion: 1,
    identity: {
      chain: "ethereum",
      chainId: 1,
      transactionHash: hash,
      blockHash: hash,
      blockNumber: 10,
      transactionIndex: 2,
    },
    transaction: {},
    receipt: { logs: [] },
    block: {},
    traces: [],
    stateDiff: { status: "unavailable", reason: "unsupported" },
    calls: [
      {
        id: "root",
        parentId: null,
        traceAddress: [],
        type: "CALL",
        from,
        to,
        storageContext: to,
        input: "0x",
        output: "0x",
        value: "0",
        reverted: false,
        readOnly: false,
      },
    ],
  };
}
test("pipeline coordinates one evidence identity and produces the complete report despite unavailable state", async () => {
  const events: string[] = [];
  let changed = false;
  let renders = 0;
  const decoder = new TransactionDecoder(
    { resolve: async () => ({ status: "not-found" }) },
    {
      validateChain: async () => {},
      validateBlock: async () => {},
      match: async () => "unavailable",
    },
  );
  const pipeline = new TransactionPipeline({
    collector: {
      collect: async (request, options) => {
        assert.equal(request.transactionHash, hash);
        assert.equal(options.includeStateDiff, true);
        return evidence();
      },
    },
    decoder,
    interpreter: new StandardTokenInterpreter(),
    validateBlock: async () => {
      events.push("canonical");
      if (changed) throw new Error("canonical block changed");
    },
    renderer: {
      render: async (input, options) => {
        renders++;
        assert.equal(options?.quality, 80);
        const diagram = new SequenceDiagramBuilder().buildDocument(input);
        return {
          ...diagram,
          svg: "<svg/>",
          jpeg: Buffer.from("jpeg"),
          width: 1,
          height: 1,
        };
      },
    },
  });
  const files = await pipeline.run(
    { chain: "ethereum", transactionHash: hash },
    { includeStateDiff: true, image: { quality: 80, scale: 1 } },
    (stage) => events.push(stage),
  );
  assert.deepEqual(events, [
    "collect",
    "decode",
    "interpret",
    "canonical",
    "render",
  ]);
  assert.deepEqual(Object.keys(files), reportFiles);
  assert.equal(
    JSON.parse(String(files["decoded.json.diagnostics.json"])).identity
      .transactionHash,
    hash,
  );
  const yaml = parse(String(files["outcomes.yaml"]));
  assert.equal(yaml.status, "success");
  assert.equal("coverage" in yaml, false);
  assert.deepEqual(yaml.token_net_from_transfers, {});
  changed = true;
  await assert.rejects(
    pipeline.run(
      { chain: "ethereum", transactionHash: hash },
      { includeStateDiff: true, image: { quality: 80, scale: 1 } },
    ),
    /canonical block changed/,
  );
  assert.equal(renders, 1);
});

test("CLI preserves existing directories and validates options before constructing clients", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pipeline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "existing");
  await mkdir(out);
  await writeFile(join(out, "keep"), "original");
  const never = async (): Promise<never> => {
    throw Error("factory must not run");
  };
  const args = ["--chain", "ethereum", "--tx", hash, "--output", out];
  await assert.rejects(runAnalyzeCli(args, never), /EEXIST/);
  assert.equal(await readFile(join(out, "keep"), "utf8"), "original");
  await assert.rejects(
    runAnalyzeCli([...args, "--quality", "101"], never),
    /quality/,
  );
  assert.match(await runAnalyzeCli(["--help"], never), /analyze/);
});

test("CLI writes all report files, forwards controls, and removes only its failed output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pipeline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "report");
  const args = [
    "--chain",
    "base",
    "--tx",
    hash,
    "--output",
    out,
    "--no-state-diff",
    "--no-cache",
    "--cached-metadata-only",
    "--quality",
    "70",
  ];
  const files = Object.fromEntries(
    reportFiles.map((name) => [name, name]),
  ) as ReportFiles;
  const message = await runAnalyzeCli(args, async (settings) => {
    assert.equal(settings.chain, "base");
    assert.equal(settings.useCache, false);
    assert.equal(settings.cachedMetadataOnly, true);
    return {
      run: async (request, options) => {
        assert.equal(request.chain, "base");
        assert.equal(options.includeStateDiff, false);
        assert.equal(options.image.quality, 70);
        return files;
      },
    };
  });
  assert.match(message, /outcomes.yaml/);
  assert.deepEqual((await readdir(out)).sort(), [...reportFiles].sort());
  assert.equal(
    await readFile(join(out, "sequence.jpg"), "utf8"),
    "sequence.jpg",
  );
  const failed = join(dir, "failed");
  await assert.rejects(
    runAnalyzeCli(
      ["--chain", "ethereum", "--tx", hash, "--output", failed],
      async () => ({
        run: async () => {
          throw Error("canonical block changed");
        },
      }),
    ),
    /canonical block/,
  );
  assert.deepEqual(await readdir(dir), ["report"]);
});
