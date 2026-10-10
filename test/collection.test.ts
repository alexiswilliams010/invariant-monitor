import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Hash } from "viem";
import { AlchemyTransactionCollector } from "../src/collection/collector.js";
import { FileCollectionCache } from "../src/collection/cache.js";
import { normalizeCalls } from "../src/collection/calls.js";
import { RpcFailure } from "../src/collection/rpc.js";
import { identityOf, validateStateDiff } from "../src/collection/validation.js";
import type {
  JsonObject,
  RpcClient,
  TransactionRequest,
} from "../src/collection/types.js";

const txHash: Hash = `0x${"11".repeat(32)}`;
const blockHash: Hash = `0x${"22".repeat(32)}`;
const otherBlock: Hash = `0x${"33".repeat(32)}`;
const sender = `0x${"aa".repeat(20)}`;
const target = `0x${"bb".repeat(20)}`;
const implementation = `0x${"cc".repeat(20)}`;
const recipient = `0x${"dd".repeat(20)}`;
const request: TransactionRequest = {
  chain: "ethereum",
  transactionHash: txHash,
};

function fixture() {
  const transaction = {
    hash: txHash,
    blockHash,
    blockNumber: "0x10",
    transactionIndex: "0x0",
    from: sender,
    to: target,
    input: "0x12345678",
    value: "0x20000000000001",
  };
  const receipt = {
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x10",
    transactionIndex: "0x0",
    status: "0x1",
    logs: [],
  };
  const block = { hash: blockHash, number: "0x10", transactions: [txHash] };
  const trace = {
    type: "call",
    action: {
      from: sender,
      to: target,
      input: "0x12345678",
      value: "0x20000000000001",
      callType: "call",
    },
    result: { output: "0x", gasUsed: "0x10" },
    traceAddress: [],
    subtraces: 0,
    transactionHash: txHash,
    blockHash,
  };
  return { transaction, receipt, block, trace };
}

class FixtureRpc implements RpcClient {
  readonly data = fixture();
  readonly methods: string[] = [];
  chain = "0x1";
  replay: unknown = { stateDiff: {} };
  traces: unknown = [this.data.trace];
  reorg = false;
  blockReads = 0;
  readonly request = (async ({ method }: { method: string }) => {
    this.methods.push(method);
    switch (method) {
      case "eth_chainId":
        return this.chain;
      case "eth_getTransactionByHash":
        return this.data.transaction;
      case "eth_getTransactionReceipt":
        return this.data.receipt;
      case "eth_getBlockByNumber":
        return this.reorg && this.blockReads++ > 0
          ? { ...this.data.block, hash: otherBlock }
          : this.data.block;
      case "trace_transaction":
        return this.traces;
      case "trace_replayTransaction":
        if (this.replay instanceof Error) throw this.replay;
        return this.replay;
      default:
        throw new Error("Unexpected RPC method.");
    }
  }) as RpcClient["request"];
}

test("collects exact quantities and does not request state diffs unless selected", async () => {
  const rpc = new FixtureRpc();
  const evidence = await new AlchemyTransactionCollector(rpc).collect(request, {
    includeStateDiff: false,
  });
  assert.equal(evidence.calls[0]?.value, "9007199254740993");
  assert.equal(evidence.stateDiff.status, "not-requested");
  assert.ok(!rpc.methods.includes("trace_replayTransaction"));
});

test("distinguishes an empty diff from unavailable state data", async () => {
  const rpc = new FixtureRpc();
  const collector = new AlchemyTransactionCollector(rpc);
  assert.deepEqual(
    (await collector.collect(request, { includeStateDiff: true })).stateDiff,
    { status: "collected", value: {} },
  );
  rpc.replay = new RpcFailure("trace_replayTransaction", -32601);
  const unavailable = await collector.collect(request, {
    includeStateDiff: true,
  });
  assert.equal(unavailable.stateDiff.status, "unavailable");
  rpc.replay = { stateDiff: null };
  assert.equal(
    (await collector.collect(request, { includeStateDiff: true })).stateDiff
      .status,
    "unavailable",
  );
  rpc.replay = {};
  await assert.rejects(
    collector.collect(request, { includeStateDiff: true }),
    /Invalid state diff/,
  );
});

test("refuses wrong chains and changed canonical blocks", async () => {
  const rpc = new FixtureRpc();
  rpc.chain = "0x2105";
  await assert.rejects(
    new AlchemyTransactionCollector(rpc).collect(request, {
      includeStateDiff: false,
    }),
    /wrong chain/,
  );
  assert.equal(rpc.methods.length, 1);
  rpc.chain = "0x1";
  rpc.reorg = true;
  await assert.rejects(
    new AlchemyTransactionCollector(rpc).collect(request, {
      includeStateDiff: false,
    }),
    /Canonical block changed/,
  );
});

test("cache skips expensive methods while refreshing canonical evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "invariant-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = new FixtureRpc();
  const cache = new FileCollectionCache(directory);
  const collector = new AlchemyTransactionCollector(rpc, cache);
  const first = await collector.collect(request, { includeStateDiff: true });
  assert.equal(collector.cacheHit, false);
  rpc.methods.length = 0;
  assert.deepEqual(
    await collector.collect(request, { includeStateDiff: true }),
    first,
  );
  assert.equal(collector.cacheHit, true);
  assert.ok(!rpc.methods.includes("trace_transaction"));
  assert.ok(!rpc.methods.includes("trace_replayTransaction"));
  assert.equal(
    rpc.methods.filter((method) => method === "eth_getBlockByNumber").length,
    2,
  );
  assert.equal(
    await cache.read({ ...first.identity, blockHash: otherBlock }, true),
    undefined,
  );
  assert.equal(
    await cache.read({ ...first.identity, chain: "base", chainId: 8453 }, true),
    undefined,
  );
  assert.equal(await cache.read(first.identity, false), undefined);
});

test("unavailable diffs are retried instead of cached as complete", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "invariant-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = new FixtureRpc();
  const collector = new AlchemyTransactionCollector(
    rpc,
    new FileCollectionCache(directory),
  );
  rpc.replay = { stateDiff: null };
  await collector.collect(request, { includeStateDiff: true });
  rpc.replay = { stateDiff: {} };
  assert.equal(
    (await collector.collect(request, { includeStateDiff: true })).stateDiff
      .status,
    "collected",
  );
  assert.equal(collector.cacheHit, false);
});

test("normalization preserves nested delegation, order, and ancestor reverts", () => {
  const { transaction, receipt, trace } = fixture();
  const child = {
    ...trace,
    traceAddress: [0],
    subtraces: 1,
    action: {
      ...trace.action,
      from: target,
      to: implementation,
      callType: "delegatecall",
      value: "0x0",
    },
    error: "reverted",
  };
  const grandchild = {
    ...trace,
    traceAddress: [0, 0],
    action: {
      ...trace.action,
      from: target,
      to: recipient,
      value: "0x0",
      callType: "delegatecall",
    },
  };
  const sibling = {
    ...trace,
    traceAddress: [1],
    action: {
      ...trace.action,
      from: target,
      to: recipient,
      callType: "staticcall",
      value: "0x0",
    },
  };
  const identity = identityOf(request, transaction, receipt);
  const { calls } = normalizeCalls(
    [sibling, grandchild, { ...trace, subtraces: 2 }, child],
    identity,
    transaction,
    receipt,
  );
  assert.deepEqual(
    calls.map((call) => call.id),
    ["root", "0", "0.0", "1"],
  );
  assert.deepEqual(
    calls.map((call) => call.reverted),
    [false, true, true, false],
  );
  assert.equal(calls[2]?.storageContext, target);
  assert.equal(calls[2]?.to, recipient);
  assert.equal(calls[3]?.readOnly, true);
});

test("rejects malformed trees, mismatched trace identities, and receipt outcomes", () => {
  const { transaction, receipt, trace } = fixture();
  const identity = identityOf(request, transaction, receipt);
  for (const traces of [
    [],
    [trace, trace],
    [{ ...trace, subtraces: 1 }],
    [{ ...trace, blockHash: otherBlock }],
    [{ ...trace, error: "failed" }],
    [trace, { ...trace, traceAddress: [0, 0] }],
  ]) {
    assert.throws(() => normalizeCalls(traces, identity, transaction, receipt));
  }
});

test("validates changed, created and deleted state values", () => {
  const word = `0x${"00".repeat(32)}`;
  const diff: JsonObject = {
    [target]: {
      balance: { "*": { from: "0x1", to: "0x0" } },
      nonce: "=",
      code: { "+": "0x6000" },
      storage: { [word]: { "-": word } },
    },
  };
  assert.deepEqual(validateStateDiff(diff), diff);
  assert.throws(() =>
    validateStateDiff({
      [target]: {
        balance: "=",
        nonce: "=",
        code: "=",
        storage: { [word]: { "*": { from: word } } },
      },
    }),
  );
});
