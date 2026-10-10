import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeEventTopics,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Address,
  type Hex,
} from "viem";
import type { CallFrame } from "../src/collection/types.js";
import type { InterpretationContext } from "../src/interpretation/types.js";
import { StandardTokenInterpreter } from "../src/interpretation/tokens.js";
import { AssetFlowProjector } from "../src/interpretation/asset-view.js";
import { SequenceDiagramBuilder } from "../src/rendering/sequence.js";
import { CallSequenceCompressor } from "../src/decoding/compression.js";
const holder = `0x${"11".repeat(20)}` as Address;
const recipient = `0x${"22".repeat(20)}` as Address;
const proxy = `0x${"33".repeat(20)}` as Address;
const second = `0x${"44".repeat(20)}` as Address;
const implementation = `0x${"55".repeat(20)}` as Address;
const hash = `0x${"aa".repeat(32)}` as Hex;
function frame(id: string, overrides: Partial<CallFrame> = {}): CallFrame {
  return {
    id,
    parentId: id === "root" ? null : "root",
    traceAddress: [],
    type: "CALL",
    from: holder,
    to: proxy,
    storageContext: proxy,
    input: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, 20n],
    }),
    output: encodeFunctionResult({
      abi: erc20Abi,
      functionName: "transfer",
      result: true,
    }),
    value: "0",
    reverted: false,
    readOnly: false,
    ...overrides,
  };
}
function log(asset: Address = proxy, index = 0, amount = 20n) {
  return {
    address: asset,
    logIndex: `0x${index.toString(16)}`,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: holder, to: recipient },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  };
}
function context(
  calls = [
    frame("root"),
    frame("delegate", {
      type: "DELEGATECALL",
      from: proxy,
      to: implementation,
    }),
  ],
  logs = [log()],
): InterpretationContext {
  const addresses = [
    { address: holder, name: "Holder" },
    { address: recipient, name: "Recipient" },
    { address: proxy, name: "Proxy" },
    { address: second, name: "Proxy_2" },
    { address: implementation, name: "Implementation" },
  ];
  const name = (address: Address | null) =>
    addresses.find((x) => x.address === address)?.name ?? "contract";
  return {
    evidence: {
      schemaVersion: 1,
      identity: {
        chain: "ethereum",
        chainId: 1,
        transactionHash: hash,
        blockHash: hash,
        blockNumber: 1,
        transactionIndex: 0,
      },
      transaction: {},
      receipt: { logs },
      block: {},
      traces: [],
      calls,
      stateDiff: { status: "not-requested" },
    },
    display: {
      schemaVersion: 3,
      chain: "ethereum",
      storage: { status: "not-requested", changes: [] },
      sequence: new CallSequenceCompressor().compress(calls).sequence,
      calls: calls.map((c) => ({
        id: c.id,
        parentId: c.parentId,
        from: name(c.from),
        to: name(c.to),
        storageContext: name(c.storageContext),
        kind: c.type,
        action: "transfer",
        args: [],
        returns: [],
        valueWei: c.value,
        reverted: c.reverted,
        readOnly: c.readOnly,
      })),
    },
    addresses,
  };
}
const interpreter = new StandardTokenInterpreter({
  async read() {
    return { symbol: "USD", decimals: 6 };
  },
});

test("proxy emission creates a holder-to-holder asset arrow, never an implementation asset", async () => {
  const input = context();
  const result = await interpreter.interpret(input);
  assert.equal(result.movements[0]?.asset, proxy);
  assert.equal(result.movements[0]?.candidateCallId, "root");
  assert.equal(result.facts[0]?.evidence.basis, "event-reported");
  const view = new AssetFlowProjector().project(input, result);
  const source = new SequenceDiagramBuilder().build(view);
  assert.match(source, /0.00002 USD/);
  assert.match(source, /Holder/);
  assert.match(source, /Recipient/);
  assert.doesNotMatch(source, /Proxy|Implementation|stroke-dash|0x[0-9a-f]/i);
});

test("two proxies sharing implementation code retain independent token identities", async () => {
  const calls = [
    frame("root", { to: holder, storageContext: holder, input: "0x" }),
    frame("a"),
    frame("a.0", {
      parentId: "a",
      type: "DELEGATECALL",
      from: proxy,
      to: implementation,
    }),
    frame("b", { to: second, storageContext: second }),
    frame("b.0", {
      parentId: "b",
      type: "DELEGATECALL",
      from: second,
      to: implementation,
      storageContext: second,
    }),
  ];
  const input = context(calls, [log(proxy, 0), log(second, 1)]);
  const result = await interpreter.interpret(input);
  assert.deepEqual(
    result.movements.map((m) => m.candidateCallId),
    ["a", "b"],
  );
  const source = new SequenceDiagramBuilder().build(
    new AssetFlowProjector().project(input, result),
  );
  assert.match(source, /0.00002 USD"/);
  assert.match(source, /0.00002 USD_2"/);
});

test("calls without events never become token movements; false, reverted, callback and amount-mismatch calls are retained", async () => {
  assert.equal(
    (await interpreter.interpret(context(undefined, []))).movements.length,
    0,
  );
  for (const overrides of [
    { reverted: true },
    {
      output: encodeFunctionResult({
        abi: erc20Abi,
        functionName: "transfer",
        result: false,
      }),
    },
    {
      input: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient, 21n],
      }),
    },
  ]) {
    const input = context([frame("root", overrides)]);
    assert.equal(
      (await interpreter.interpret(input)).movements[0]?.candidateCallId,
      undefined,
    );
  }
  const input = context([
    frame("root"),
    frame("callback", {
      from: proxy,
      to: recipient,
      storageContext: recipient,
    }),
  ]);
  const result = await interpreter.interpret(input);
  assert.equal(result.movements[0]?.candidateCallId, undefined);
  const view = new AssetFlowProjector().project(input, result);
  assert.equal(view.unplacedMovements?.length, 1);
  const source = new SequenceDiagramBuilder().build(view);
  assert.match(source, /Reported transfers · call position unknown/);
  assert.match(source, /transfer/);
});

test("unplaced zero transfers remain in evidence but not in the image", async () => {
  const input = context([frame("root", { input: "0x" })], [log(proxy, 0, 0n)]);
  const result = await interpreter.interpret(input);
  const view = new AssetFlowProjector().project(input, result);
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0]?.amount, "0");
  assert.deepEqual(view.unplacedMovements, []);
  assert.doesNotMatch(
    new SequenceDiagramBuilder().build(view),
    /Reported transfers|0 units/,
  );
});

test("ambiguous identical calls, multiple matching logs and NFT event layouts do not collapse", async () => {
  const calls = [frame("root", { input: "0x" }), frame("a"), frame("b")];
  assert.equal(
    (await interpreter.interpret(context(calls))).movements[0]?.candidateCallId,
    undefined,
  );
  const duplicates = await interpreter.interpret(
    context(undefined, [log(proxy, 0), log(proxy, 1)]),
  );
  assert.ok(duplicates.movements.every((m) => m.candidateCallId === undefined));
  const nft = log();
  nft.topics.push(encodeAbiParameters([{ type: "uint256" }], [1n]));
  nft.data = "0x";
  assert.equal(
    (await interpreter.interpret(context(undefined, [nft]))).movements.length,
    0,
  );
});

test("unknown decimals retain raw units and repeated representatives do not stand for every transfer amount", async () => {
  const input = context(
    [
      frame("root", { input: "0x" }),
      frame("a"),
      frame("b", {
        input: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, 30n],
        }),
      }),
    ],
    [log(proxy, 0), log(proxy, 1, 30n)],
  );
  const result = await new StandardTokenInterpreter().interpret(input);
  const view = new AssetFlowProjector().project(input, result);
  assert.equal(view.unplacedMovements?.length, 2);
  const source = new SequenceDiagramBuilder().build(view);
  assert.match(source, /20 units Asset_1/);
  assert.match(source, /30 units Asset_1/);
  assert.match(source, /transfer ×2/);
});

test("native value becomes flow only for successful empty-calldata leaves", async () => {
  for (const overrides of [
    { input: "0x" as Hex },
    { input: "0x12345678" as Hex },
    { input: "0x" as Hex, reverted: true },
  ]) {
    const input = context(
      [frame("root", { ...overrides, value: "1000000000000000000" })],
      [],
    );
    const result = await interpreter.interpret(input);
    const view = new AssetFlowProjector().project(input, result);
    const expected = overrides.input === "0x" && !overrides.reverted;
    assert.equal(view.calls.get("root")?.assetMovement === true, expected);
    if (expected) assert.equal(view.calls.get("root")?.action, "1 ETH");
  }
});

test("metadata reads support optional legacy bytes32 symbols and retain unknown decimals", async () => {
  const { RpcTokenMetadataReader } =
    await import("../src/interpretation/tokens.js");
  const { stringToHex } = await import("viem");
  const rpc = {
    request: async ({ params }: { params: readonly unknown[] }) => {
      assert.equal(params[1], "0x1");
      const request = params[0] as { to: Address; data: Hex };
      assert.equal(request.to, proxy);
      if (
        request.data ===
        encodeFunctionData({ abi: erc20Abi, functionName: "symbol" })
      )
        return stringToHex("TEST", { size: 32 });
      throw new Error("Unavailable");
    },
  } as unknown as import("../src/collection/types.js").RpcClient;
  assert.deepEqual(await new RpcTokenMetadataReader(rpc, "0x1").read(proxy), {
    symbol: "TEST",
  });
});
