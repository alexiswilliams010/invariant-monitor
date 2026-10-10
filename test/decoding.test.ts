import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hash,
} from "viem";
import type {
  JsonObject,
  RpcClient,
  TransactionEvidence,
} from "../src/collection/types.js";
import type { ContractMetadata } from "../src/metadata/types.js";
import { AbiDecoder } from "../src/decoding/abi.js";
import { HistoricalCodeMatcher } from "../src/decoding/binding.js";
import { TransactionDecoder } from "../src/decoding/decoder.js";
import { readEvidence } from "../src/decoding/evidence.js";
import {
  AddressNames,
  displayArguments,
  displayText,
} from "../src/decoding/presentation.js";
import { RpcFailure } from "../src/collection/rpc.js";

const sender: Address = `0x${"aa".repeat(20)}`;

test("hex sanitization preserves numeric suffixes within compiler identifiers", () => {
  assert.equal(displayText("feeGrowthGlobal0X128"), "feeGrowthGlobal0X128");
  assert.equal(displayText("value: 0xabcdef"), "value: bytes");
});
const target: Address = `0x${"bb".repeat(20)}`;
const another: Address = `0x${"cc".repeat(20)}`;
const txHash: Hash = `0x${"11".repeat(32)}`;
const blockHash: Hash = `0x${"22".repeat(32)}`;
const abi = parseAbi([
  "function record(address who, uint256 amount, (bytes32 data, string text) detail) returns (uint256 count)",
]);
const data = encodeFunctionData({
  abi,
  functionName: "record",
  args: [
    another,
    9007199254740993n,
    { data: `0x${"33".repeat(32)}`, text: `memo ${another}` },
  ],
});

function evidence(): TransactionEvidence {
  const transaction = {
    hash: txHash,
    from: sender,
    to: target,
    input: data,
    value: "0x0",
    blockHash,
    blockNumber: "0x10",
    transactionIndex: "0x0",
  };
  const receipt = {
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x10",
    transactionIndex: "0x0",
    status: "0x1",
    logs: [],
  };
  const output = encodeAbiParameters(
    [{ type: "uint256" }],
    [9007199254740993n],
  );
  const identity = {
    chain: "ethereum" as const,
    chainId: 1,
    transactionHash: txHash,
    blockHash,
    blockNumber: 16,
    transactionIndex: 0,
  };
  return readEvidence({
    schemaVersion: 1,
    identity,
    transaction,
    receipt,
    block: { number: "0x10", hash: blockHash, transactions: [txHash] },
    traces: [
      {
        type: "call",
        action: {
          from: sender,
          to: target,
          input: data,
          value: "0x0",
          callType: "call",
        },
        result: { output },
        traceAddress: [],
        subtraces: 0,
        blockHash,
        transactionHash: txHash,
      },
    ],
    stateDiff: { status: "not-requested" },
  });
}

function metadata(): ContractMetadata {
  return {
    schemaVersion: 1,
    identity: { chainId: 1, address: target },
    source: "sourcify",
    fetchedAt: "2026-01-01T00:00:00Z",
    verifiedAt: "2025-01-01T00:00:00Z",
    matchId: "1",
    creationMatch: null,
    runtimeMatch: "match",
    compilation: {
      name: "Recorder",
      fullyQualifiedName: null,
      language: "Solidity",
      compiler: "solc",
      compilerVersion: "0.8.30",
    },
    deployment: {
      transactionHash: null,
      blockNumber: "1",
      transactionIndex: "0",
      deployer: null,
    },
    runtimeCodeHash: keccak256("0x6000"),
    abi: abi as unknown as readonly JsonObject[],
    storageLayout: null,
  };
}

test("ABI decoding preserves exact numbers and uses recursive type fallbacks with no display hex", () => {
  const decoded = new AbiDecoder(abi).decode(data);
  assert.ok(decoded?.args);
  const names = new AddressNames();
  names.register(another, "Recipient");
  const args = displayArguments(decoded.callable.inputs, decoded.args, names);
  assert.equal(args[0]?.value, "Recipient");
  assert.equal(args[1]?.value, "9007199254740993");
  assert.deepEqual(args[2]?.value, [
    { name: "data", type: "bytes32" },
    { name: "text", type: "string", value: "memo bytes" },
  ]);
  assert.doesNotMatch(JSON.stringify(args), /0x[0-9a-f]/i);
});

test("selector collisions remain unknown and malformed/trailing calldata only retains types", () => {
  const collision = parseAbi([
    "function burn(uint256 value)",
    "function collate_propagate_storage(bytes16 value)",
  ]);
  const input = encodeFunctionData({
    abi: collision,
    functionName: "burn",
    args: [1n],
  });
  assert.equal(new AbiDecoder(collision).decode(input), null);
  const decoder = new AbiDecoder(abi);
  assert.equal(decoder.decode(`${data}00`)?.args, null);
  assert.equal(decoder.decode(data.slice(0, 10) as typeof data)?.args, null);
  assert.equal(decoder.decode("0xdeadbeef"), null);
  const result = decoder.decode(`${data}00`)!;
  assert.ok(
    displayArguments(
      result.callable.inputs,
      result.args,
      new AddressNames(),
    ).every((item) => item.value === undefined),
  );
});

test("array and tuple values decode recursively, while oversized arrays retain only the type", () => {
  const listAbi = parseAbi([
    "function list((address who, int256 value)[] items, bytes extra)",
  ]);
  const input = encodeFunctionData({
    abi: listAbi,
    functionName: "list",
    args: [[{ who: another, value: -2n }], "0x1234"],
  });
  const decoded = new AbiDecoder(listAbi).decode(input)!;
  const args = displayArguments(
    decoded.callable.inputs,
    decoded.args,
    new AddressNames(),
  );
  assert.deepEqual(args[0]?.value, [
    {
      name: "",
      type: "tuple",
      value: [
        { name: "who", type: "address", value: "Contract_A" },
        { name: "value", type: "int256", value: "-2" },
      ],
    },
  ]);
  assert.deepEqual(args[1], { name: "extra", type: "bytes" });
  assert.deepEqual(
    displayArguments(
      [{ type: "uint256[]" }],
      [Array(257).fill(1n)],
      new AddressNames(),
    ),
    [{ name: "", type: "uint256[]" }],
  );
});

test("labels preserve known names, distinguish equal names, and only mark known creations as new", () => {
  const names = new AddressNames();
  assert.equal(names.register(target, "Recorder"), "Recorder");
  assert.equal(names.register(another, "Recorder"), "Recorder_2");
  assert.equal(names.register(sender, null, true), "New_ContractA");
  assert.equal(names.register(target), "Recorder");
});

function rpc(
  codes: readonly string[] = ["0x6000", "0x6000"],
): RpcClient & { methods: string[] } {
  let reads = 0;
  const methods: string[] = [];
  return {
    methods,
    request: (async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") return evidence().block;
      if (method === "eth_getCode") return codes[reads++];
      throw new Error("Unexpected RPC method");
    }) as RpcClient["request"],
  };
}

test("historical code binding checks both block boundaries and refuses code changes", async () => {
  const client = rpc();
  const matcher = new HistoricalCodeMatcher(client);
  await matcher.validateChain(evidence());
  assert.equal(
    await matcher.match(evidence(), target, metadata()),
    "block-code-match",
  );
  assert.equal(
    client.methods.filter((method) => method === "eth_getCode").length,
    2,
  );
  assert.equal(
    await new HistoricalCodeMatcher(rpc(["0x6001", "0x6000"])).match(
      evidence(),
      target,
      metadata(),
    ),
    "code-mismatch",
  );
  assert.equal(
    await matcher.match(evidence(), target, {
      ...metadata(),
      identity: { chainId: 8453, address: target },
    }),
    "unavailable",
  );
  const changed = evidence();
  assert.equal(
    await matcher.match(changed, target, {
      ...metadata(),
      deployment: { ...metadata().deployment, blockNumber: "17" },
    }),
    "unavailable",
  );
  assert.equal(
    await matcher.match(
      { ...changed, calls: [{ ...changed.calls[0]!, type: "CREATE" }] },
      target,
      metadata(),
    ),
    "code-change",
  );
  assert.equal(
    await matcher.match(
      {
        ...changed,
        stateDiff: {
          status: "collected",
          value: { [target]: { code: { "+": "0x6000" } } },
        },
      },
      target,
      metadata(),
    ),
    "code-change",
  );
  const failing: RpcClient = {
    request: (async () => {
      throw new RpcFailure("eth_getCode");
    }) as RpcClient["request"],
  };
  assert.equal(
    await new HistoricalCodeMatcher(failing).match(
      evidence(),
      target,
      metadata(),
    ),
    "unavailable",
  );
});

test("decoder keeps delegation edges, suppresses unbound ABI names, and separates diagnostic hex", async () => {
  const source = {
    resolve: async () => ({ status: "found" as const, metadata: metadata() }),
  };
  const result = await new TransactionDecoder(
    source,
    new HistoricalCodeMatcher(rpc()),
  ).decode(evidence());
  assert.equal(result.display.calls[0]?.action, "record");
  assert.equal(result.display.calls[0]?.to, "Recorder");
  assert.equal(result.display.calls[0]?.returns[0]?.value, "9007199254740993");
  const reverted = await new TransactionDecoder(
    source,
    new HistoricalCodeMatcher(rpc()),
  ).decode({
    ...evidence(),
    calls: [{ ...evidence().calls[0]!, reverted: true }],
  });
  assert.deepEqual(reverted.display.calls[0]?.returns, [
    { name: "", type: "bytes" },
  ]);
  assert.doesNotMatch(JSON.stringify(result.display), /0x[0-9a-f]/i);
  assert.match(JSON.stringify(result.diagnostics), /0x[0-9a-f]/i);
  const unbound = await new TransactionDecoder(
    source,
    new HistoricalCodeMatcher(rpc(["0x6001", "0x6001"])),
  ).decode(evidence());
  assert.equal(unbound.display.calls[0]?.action, "call");
  assert.notEqual(unbound.display.calls[0]?.to, "Recorder");
  const e = evidence();
  const delegated = {
    ...e,
    calls: [
      ...e.calls,
      {
        ...e.calls[0]!,
        id: "0",
        parentId: "root",
        from: target,
        to: another,
        storageContext: target,
        type: "DELEGATECALL" as const,
      },
    ],
  };
  const missing = { resolve: async () => ({ status: "not-found" as const }) };
  const nested = await new TransactionDecoder(
    missing,
    new HistoricalCodeMatcher(rpc()),
  ).decode(delegated);
  assert.equal(nested.display.calls.length, 2);
  assert.equal(nested.display.calls[1]?.from, nested.display.calls[0]?.to);
  assert.equal(nested.display.calls[1]?.parentId, "root");
  assert.equal(
    nested.display.calls[1]?.storageContext,
    nested.display.calls[0]?.to,
  );
  assert.notEqual(nested.display.calls[1]?.to, nested.display.calls[0]?.to);
});

test("imported evidence rebuilds call frames from raw traces and rejects identity tampering", () => {
  const original = evidence();
  assert.deepEqual(
    readEvidence({ ...original, calls: [{ from: "forged" }] }).calls,
    original.calls,
  );
  assert.throws(
    () =>
      readEvidence({
        ...original,
        identity: { ...original.identity, chainId: 8453 },
      }),
    /identity mismatch/,
  );
});
