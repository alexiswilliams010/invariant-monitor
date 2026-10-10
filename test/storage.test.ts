import assert from "node:assert/strict";
import { test } from "node:test";
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
} from "viem";
import type {
  JsonObject,
  TransactionEvidence,
} from "../src/collection/types.js";
import type { ContractMetadata } from "../src/metadata/types.js";
import { AddressNames } from "../src/decoding/presentation.js";
import { StorageCandidates } from "../src/decoding/storage-candidates.js";
import { SolidityStorageLayout } from "../src/decoding/storage-layout.js";
import { StorageDecoder } from "../src/decoding/storage.js";

const host: Address = `0x${"ab".repeat(20)}`;
const impl: Address = `0x${"cd".repeat(20)}`;
const sender: Address = `0x${"ef".repeat(20)}`;
const uint = { encoding: "inplace", label: "uint256", numberOfBytes: "32" };
const addr = { encoding: "inplace", label: "address", numberOfBytes: "20" };
const field = (label: string, slot: string, type: string, offset = 0) => ({
  label,
  slot,
  type,
  offset,
});
const changed = (before: bigint, after: bigint) => ({
  "*": { from: toHex(before, { size: 32 }), to: toHex(after, { size: 32 }) },
});

function evidence(storage: JsonObject): TransactionEvidence {
  return {
    schemaVersion: 1,
    identity: {
      chain: "ethereum",
      chainId: 1,
      transactionHash: toHex(1, { size: 32 }),
      blockHash: toHex(2, { size: 32 }),
      blockNumber: 16,
      transactionIndex: 0,
    },
    transaction: {},
    receipt: { logs: [] },
    block: {},
    traces: [],
    calls: [
      {
        id: "root",
        parentId: null,
        traceAddress: [],
        type: "CALL",
        from: sender,
        to: host,
        storageContext: host,
        input: "0x",
        output: "0x",
        value: "0",
        reverted: false,
        readOnly: false,
      },
    ],
    stateDiff: { status: "collected", value: { [host]: { storage } } },
  };
}

function metadata(layout: JsonObject, address = host): ContractMetadata {
  return {
    schemaVersion: 1,
    identity: { chainId: 1, address },
    source: "sourcify",
    fetchedAt: "2026-01-01T00:00:00Z",
    verifiedAt: "2025-01-01T00:00:00Z",
    matchId: "1",
    creationMatch: null,
    runtimeMatch: "match",
    runtimeCodeHash: toHex(1, { size: 32 }),
    compilation: {
      name: "Example",
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
    abi: [],
    storageLayout: layout,
  };
}

function decode(
  e: TransactionEvidence,
  layouts: ContractMetadata[],
  setup?: (candidates: StorageCandidates) => void,
) {
  const candidates = new StorageCandidates(e);
  setup?.(candidates);
  const names = new AddressNames();
  names.register(host, "Host");
  names.register(sender, "Sender");
  const result = new StorageDecoder(candidates, names).decode(
    e,
    new Map(layouts.map((m) => [m.identity.address, m])),
  );
  assert.doesNotMatch(JSON.stringify(result.display), /0x[0-9a-f]/i);
  return result;
}

test("packed fields decode signed values and addresses without inventing changes to neighboring fields", () => {
  const layout = {
    storage: [
      field("count", "0", "i", 0),
      field("active", "0", "b", 1),
      field("owner", "1", "a"),
    ],
    types: {
      i: { encoding: "inplace", label: "int8", numberOfBytes: "1" },
      b: { encoding: "inplace", label: "bool", numberOfBytes: "1" },
      a: addr,
    },
  };
  const e = evidence({
    [toHex(0, { size: 32 })]: changed(0x1ffn, 0x102n),
    [toHex(1, { size: 32 })]: changed(BigInt(host), BigInt(sender)),
  });
  const result = decode(e, [metadata(layout)]);
  assert.deepEqual(
    result.display.changes.map(({ name, before, after, delta }) => ({
      name,
      before,
      after,
      delta,
    })),
    [
      { name: "count", before: "-1", after: "2", delta: "3" },
      { name: "owner", before: "Host", after: "Sender", delta: undefined },
    ],
  );
  const partial = decode(
    evidence({ [toHex(0, { size: 32 })]: changed(0n, 0x10001n) }),
    [metadata(layout)],
  );
  assert.deepEqual(
    partial.display.changes.map((change) => change.name),
    ["count", "storage"],
  );
  assert.equal(partial.diagnostics.slots[0]?.status, "partial");
});

test("nested mapping and struct slots are attributed only after the declared key hashes match", () => {
  const first = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [sender, 5n],
    ),
  );
  const second = BigInt(keccak256(concatHex([toHex(7, { size: 32 }), first])));
  const layout = {
    storage: [field("records", "5", "m")],
    types: {
      a: addr,
      u: uint,
      m: {
        encoding: "mapping",
        label: "mapping(address => mapping(uint256 => struct Entry))",
        numberOfBytes: "32",
        key: "a",
        value: "inner",
      },
      inner: {
        encoding: "mapping",
        label: "mapping(uint256 => struct Entry)",
        numberOfBytes: "32",
        key: "u",
        value: "s",
      },
      s: {
        encoding: "inplace",
        label: "struct Entry",
        numberOfBytes: "64",
        members: [field("value", "1", "u")],
      },
    },
  };
  const e = evidence({
    [toHex(second + 1n, { size: 32 })]: changed(10n, 30n),
    [toHex(second + 2n, { size: 32 })]: changed(1n, 2n),
  });
  const result = decode(e, [metadata(layout)], (c) =>
    c.addParameters([{ type: "uint256" }], [7n]),
  );
  assert.equal(result.display.changes[0]?.name, "records[Sender][7].value");
  assert.equal(result.display.changes[0]?.delta, "20");
  assert.equal(result.display.changes[1]?.name, "storage");
});

test("delegate-call layouts use the host context, while conflicting layouts stay unattributed", () => {
  const layout = { storage: [field("counter", "0", "u")], types: { u: uint } };
  const e = evidence({ [toHex(0, { size: 32 })]: changed(1n, 2n) });
  const delegated = {
    ...e,
    calls: [
      ...e.calls,
      {
        ...e.calls[0]!,
        id: "0",
        parentId: "root",
        from: host,
        to: impl,
        type: "DELEGATECALL" as const,
      },
    ],
  };
  assert.equal(
    decode(delegated, [metadata(layout, impl)]).display.changes[0]?.contract,
    "Host",
  );
  const conflicting = decode(delegated, [
    metadata(layout, impl),
    metadata({ ...layout, storage: [field("other", "0", "u")] }),
  ]);
  assert.equal(conflicting.display.changes[0]?.name, "storage");
  assert.equal(conflicting.diagnostics.slots[0]?.status, "ambiguous");
  const reverted = {
    ...delegated,
    calls: delegated.calls.map((call) => ({ ...call, reverted: true })),
  };
  assert.equal(
    decode(reverted, [metadata(layout, impl)]).display.changes[0]?.name,
    "storage",
  );
});

test("fixed and dynamic arrays honor element packing and keep unknown-length arrays unresolved", () => {
  const layout = {
    storage: [field("fixed", "0", "fixed"), field("items", "1", "dynamic")],
    types: {
      byte: { encoding: "inplace", label: "uint8", numberOfBytes: "1" },
      fixed: {
        encoding: "inplace",
        label: "uint8[3]",
        numberOfBytes: "32",
        base: "byte",
      },
      dynamic: {
        encoding: "dynamic_array",
        label: "uint8[]",
        numberOfBytes: "32",
        base: "byte",
      },
    },
  };
  const start = keccak256(toHex(1, { size: 32 }));
  const result = decode(
    evidence({
      [toHex(0, { size: 32 })]: changed(0n, 0x020100n),
      [toHex(1, { size: 32 })]: changed(0n, 2n),
      [start]: changed(0n, 0x0706n),
    }),
    [metadata(layout)],
  );
  assert.deepEqual(
    result.display.changes.map((change) => change.name),
    ["fixed[1]", "fixed[2]", "items.length", "items[0]", "items[1]"],
  );
  const unknown = decode(evidence({ [start]: changed(1n, 2n) }), [
    metadata(layout),
  ]);
  assert.equal(unknown.display.changes[0]?.name, "storage");
  assert.equal(unknown.diagnostics.limited, true);
});

test("dynamic mapping keys use unpadded bytes and opaque keys display unknown", () => {
  const layout = {
    storage: [field("names", "0", "m"), field("ids", "1", "n")],
    types: {
      u: uint,
      text: { encoding: "bytes", label: "string", numberOfBytes: "32" },
      key: { encoding: "inplace", label: "bytes32", numberOfBytes: "32" },
      m: {
        encoding: "mapping",
        label: "mapping(string => uint256)",
        numberOfBytes: "32",
        key: "text",
        value: "u",
      },
      n: {
        encoding: "mapping",
        label: "mapping(bytes32 => uint256)",
        numberOfBytes: "32",
        key: "key",
        value: "u",
      },
    },
  };
  const key = toHex(99, { size: 32 });
  const slot = keccak256(concatHex([toHex("hello"), toHex(0, { size: 32 })]));
  const opaque = keccak256(concatHex([key, toHex(1, { size: 32 })]));
  const result = decode(
    evidence({ [slot]: changed(0n, 1n), [opaque]: changed(1n, 2n) }),
    [metadata(layout)],
    (c) =>
      c.addParameters(
        [{ type: "string" }, { type: "bytes32" }],
        ["hello", key],
      ),
  );
  assert.deepEqual(
    result.display.changes.map((change) => change.name),
    ["names[hello]", "ids[unknown]"],
  );
});

test("short strings decode while raw bytes remain types; missing layouts and diffs stay explicit", () => {
  assert.equal(
    SolidityStorageLayout.parse({
      storage: [field("x", "0", "u")],
      types: { u: { ...uint, numberOfBytes: "1" } },
    }),
    null,
  );
  const layout = {
    storage: [field("title", "0", "s"), field("data", "1", "b")],
    types: {
      s: { encoding: "bytes", label: "string", numberOfBytes: "32" },
      b: { encoding: "inplace", label: "bytes32", numberOfBytes: "32" },
    },
  };
  const text = BigInt(
    `0x${Buffer.from("hi").toString("hex").padEnd(62, "0")}04`,
  );
  const e = evidence({
    [toHex(0, { size: 32 })]: changed(0n, text),
    [toHex(1, { size: 32 })]: { "+": toHex(3, { size: 32 }) },
  });
  const result = decode(e, [metadata(layout)]);
  assert.equal(result.display.changes[0]?.after, "hi");
  assert.equal(result.display.changes[1]?.type, "bytes32");
  assert.equal(result.display.changes[1]?.after, undefined);
  assert.ok(
    decode(e, []).display.changes.every((change) => change.name === "storage"),
  );
  assert.equal(
    decode({ ...e, stateDiff: { status: "not-requested" } }, []).display.status,
    "not-requested",
  );
  assert.equal(
    SolidityStorageLayout.parse({
      storage: [field("x", "0", "missing")],
      types: {},
    }),
    null,
  );
  assert.equal(
    SolidityStorageLayout.parse({
      storage: [field("x", "0", "u", 32)],
      types: { u: uint },
    }),
    null,
  );
});

test("recursive layout traversal is bounded and preserves unresolved changes", () => {
  const layout = {
    storage: [field("count", "0", "u"), field("cycle", "1", "s")],
    types: {
      u: uint,
      s: {
        encoding: "inplace",
        label: "struct Recursive",
        numberOfBytes: "32",
        members: [field("child", "0", "s")],
      },
    },
  };
  const result = decode(
    evidence({ [toHex(0, { size: 32 })]: changed(1n, 2n) }),
    [metadata(layout)],
  );
  assert.equal(result.diagnostics.limited, true);
  assert.equal(result.display.changes.length, 1);
  assert.equal(result.display.changes[0]?.name, "storage");
});
