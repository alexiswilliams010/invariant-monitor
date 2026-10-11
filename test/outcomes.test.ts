import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { encodeFunctionData, encodeFunctionResult, erc20Abi } from "viem";
import { OutcomeExporter } from "../src/interpretation/outcomes.js";
import { callContextFacts } from "../src/interpretation/call-context.js";
import { nativeTransfers } from "../src/interpretation/native.js";
import { numericStateDelta } from "../src/interpretation/state-delta.js";
import type { InterpretationContext } from "../src/interpretation/types.js";
import type { TokenInterpretation } from "../src/interpretation/tokens.js";
import { AssetFlowProjector } from "../src/interpretation/asset-view.js";
import { SequenceDiagramBuilder } from "../src/rendering/sequence.js";
const a = `0x${"aa".repeat(20)}` as const;
const b = `0x${"bb".repeat(20)}` as const;
const token = `0x${"cc".repeat(20)}` as const;
const second = `0x${"dd".repeat(20)}` as const;
const hash = `0x${"11".repeat(32)}` as const;
function context(): InterpretationContext {
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
      receipt: {},
      block: {},
      traces: [],
      stateDiff: { status: "collected", value: {} },
      calls: [
        {
          id: "root",
          parentId: null,
          traceAddress: [],
          type: "CALL",
          from: a,
          to: b,
          storageContext: b,
          input: "0x",
          output: "0x",
          value: "0",
          reverted: false,
          readOnly: false,
        },
      ],
    },
    display: {
      schemaVersion: 3,
      chain: "ethereum",
      calls: [
        {
          id: "root",
          parentId: null,
          from: "Account",
          to: "Proxy",
          storageContext: "Proxy",
          kind: "CALL",
          action: "execute",
          args: [],
          returns: [],
          valueWei: "0",
          reverted: false,
          readOnly: false,
        },
      ],
      sequence: [{ kind: "call", callId: "root", children: [] }],
      storage: {
        status: "collected",
        changes: [
          {
            id: "s1",
            contract: "Proxy",
            name: "shares[Account]",
            type: "uint256",
            before: "900719925474099312345",
            after: "900719925474099312346",
          },
          { id: "s2", contract: "Proxy", name: "storage" },
          { id: "s3", contract: "Proxy", name: "opaque", type: "bytes32" },
          {
            id: "s4",
            contract: "Proxy",
            name: "flag",
            type: "bool",
            before: false,
            after: true,
          },
        ],
      },
    },
    addresses: [
      { address: a, name: "Account" },
      { address: b, name: "Proxy" },
      { address: token, name: "Token" },
      { address: second, name: "OtherToken" },
    ],
  };
}
function tokens(): TokenInterpretation {
  return {
    status: "interpreted",
    facts: [],
    hiddenReadIds: [],
    metadata: new Map([
      [token, { symbol: "USD", decimals: 6 }],
      [second, { symbol: "USD" }],
    ]),
    movements: [
      { asset: token, from: a, to: b, amount: "25000000", logIndex: 0 },
      { asset: token, from: b, to: a, amount: "5000000", logIndex: 1 },
      {
        asset: token,
        from: a,
        to: a,
        amount: "99999999999999999999",
        logIndex: 2,
      },
      {
        asset: second,
        from: null,
        to: b,
        amount: "900719925474099312345",
        logIndex: 3,
      },
    ],
  };
}
function build(input = context(), interpreted = tokens()) {
  const diagram = new AssetFlowProjector().project(input, interpreted);
  const names = new SequenceDiagramBuilder().buildDocument(diagram).names;
  return new OutcomeExporter().build(
    input,
    interpreted,
    diagram,
    new Map([...names, ["Proxy", "Safe"], ["Account", "Owner"]]),
  );
}

test("YAML adds observed balance percentages and keeps denominator provenance out of model input", () => {
  const input = context();
  const calls = [a, b].map((holder, index) => ({
    ...input.evidence.calls[0]!,
    id: `balance-${index}`,
    parentId: "root",
    type: "STATICCALL" as const,
    to: token,
    storageContext: token,
    readOnly: true,
    input: encodeFunctionData({
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    }),
    output: encodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      result: index === 0 ? 20_000_000n : 0n,
    }),
  }));
  const result = build({
    ...input,
    evidence: { ...input.evidence, calls: [...input.evidence.calls, ...calls] },
  });
  assert.deepEqual(result.document.token_net_from_transfers.Owner, [
    "-20 USD (-100%)",
  ]);
  assert.equal(
    result.document.token_net_from_transfers.Safe?.[0],
    "+20 USD (new balance)",
  );
  assert.equal(
    result.diagnostics.tokenReferences[0]?.balance?.amount,
    "20000000",
  );
  assert.doesNotMatch(result.yaml, /callIds|balanceOf-before-token-writes/);
});
test("YAML sums exact net amounts per asset and holder, including minting and self transfers", () => {
  const result = build();
  assert.deepEqual(result.document.token_net_from_transfers, {
    Owner: ["-20 USD"],
    Safe: ["+20 USD", "+900719925474099312345 units USD_2"],
  });
  assert.deepEqual(parse(result.yaml), result.document);
  assert.doesNotMatch(result.yaml, /0x|logIndex|callId/);
  assert.equal(result.document.initiator, "Owner");
  assert.equal(result.document.call_context[0]?.function, "execute");
  assert.equal(result.diagnostics.tokenReferences.length, 3);
});
test("decoded state preserves exact scalar types and shared names while omitting unknown values", () => {
  const result = build();
  assert.deepEqual(result.document.decoded_state.Safe, [
    {
      field: "shares[Owner]",
      type: "uint256",
      before: "900719925474099312345",
      after: "900719925474099312346",
      delta: "+1",
    },
    { field: "flag", type: "bool", before: false, after: true },
  ]);
  assert.equal(result.diagnostics.coverage.omitted_state_changes, 2);
  assert.equal("coverage" in parse(result.yaml), false);
});
test("zero totals disappear and unavailable state stays explicit", () => {
  const input = context();
  const result = build(
    {
      ...input,
      display: {
        ...input.display,
        storage: { status: "unavailable", changes: [] },
      },
    },
    {
      ...tokens(),
      movements: [
        { asset: token, from: a, to: b, amount: "20", logIndex: 0 },
        { asset: token, from: b, to: a, amount: "20", logIndex: 1 },
      ],
    },
  );
  assert.deepEqual(result.document.token_net_from_transfers, {});
  assert.deepEqual(result.document.decoded_state, {});
  assert.equal(result.diagnostics.coverage.state_diff, "unavailable");
});
test("native transfers net routed value without counting delegation or reverted effects", () => {
  const root = context().evidence.calls[0]!;
  const calls = [
    { ...root, value: "1000000000000000000" },
    {
      ...root,
      id: "0",
      parentId: "root",
      from: b,
      to: token,
      value: "1000000000000000000",
    },
    {
      ...root,
      id: "1",
      parentId: "root",
      type: "DELEGATECALL" as const,
      value: "1000000000000000000",
    },
    {
      ...root,
      id: "2",
      parentId: "root",
      type: "CALLCODE" as const,
      value: "1000000000000000000",
    },
    { ...root, id: "3", parentId: "root", reverted: true, value: "100" },
    { ...root, id: "4", parentId: "root", from: b, to: b, value: "100" },
  ];
  const result = nativeTransfers(calls);
  assert.equal(result.movements.length, 2);
  assert.deepEqual(result.totals, [
    [a, -1000000000000000000n],
    [token, 1000000000000000000n],
  ]);
  assert.equal(
    nativeTransfers(calls.map((call) => ({ ...call, reverted: true })))
      .movements.length,
    0,
  );
  const creation = nativeTransfers([
    { ...root, type: "CREATE" as const, value: "5" },
    { ...root, type: "CREATE2" as const, value: "7" },
    { ...root, type: "SELFDESTRUCT" as const, value: "11" },
  ]);
  assert.deepEqual(creation.totals, [
    [a, -23n],
    [b, 23n],
  ]);
  const exported = build({
    ...context(),
    evidence: {
      ...context().evidence,
      calls: [{ ...root, value: "10590535811" }],
    },
  });
  assert.deepEqual(exported.document.native_net_from_transfers, {
    Owner: "-0.000000010590535811 ETH",
    Safe: "+0.000000010590535811 ETH",
  });
});

test("numeric state deltas retain integer precision without interpreting address or boolean values", () => {
  const before = (2n ** 256n - 1n).toString();
  assert.equal(
    numericStateDelta(
      "uint256",
      before,
      (BigInt(before) - 8230000n).toString(),
    ),
    "-8230000",
  );
  assert.equal(
    numericStateDelta("int256", "-9007199254740993000", "9007199254740993000"),
    "+18014398509481986000",
  );
  assert.equal(numericStateDelta("bool", false, true), undefined);
  assert.equal(numericStateDelta("address", "123", "456"), undefined);
  assert.equal(numericStateDelta("uint256", "unknown", "5"), undefined);
});

test("call context retains more than 24 calls and nested argument values", () => {
  const input = context();
  const values = Array.from({ length: 30 }, (_, index) => ({
    name: "",
    type: "address",
    value: index === 29 ? "OtherToken" : "Account",
  }));
  const calls = Array.from({ length: 37 }, (_, index) => ({
    ...input.display.calls[0]!,
    id: index === 0 ? "root" : String(index),
    parentId: index === 0 ? null : "root",
    args: [{ name: "recipients", type: "address[]", value: values }],
  }));
  const result = callContextFacts(
    {
      ...input,
      display: { ...input.display, calls },
      evidence: {
        ...input.evidence,
        calls: calls.map((call) => ({
          ...input.evidence.calls[0]!,
          id: call.id,
          parentId: call.parentId,
        })),
      },
    },
    (name) => name,
  );
  assert.equal(result.calls.length, 37);
  assert.equal(result.references.length, 37);
  assert.equal(
    (
      result.calls[36]!.arguments["recipients (address[])"] as Record<
        string,
        unknown
      >
    )["arg30 (address)"],
    "OtherToken",
  );
});

test("YAML safely quotes arbitrary metadata and preserves evidence", () => {
  const input = context();
  const before = structuredClone(input);
  const interpreted = tokens();
  const result = build(input, {
    ...interpreted,
    metadata: new Map([
      [token, { symbol: 'USD: [x] # "test"', decimals: 6 }],
      [second, {}],
    ]),
  });
  assert.deepEqual(parse(result.yaml), result.document);
  assert.deepEqual(input, before);
});

test("call context preserves initiator, delegation sender, intermediate path and ABI argument names", () => {
  const input = context();
  const root = input.evidence.calls[0]!;
  const displayRoot = input.display.calls[0]!;
  const enriched: InterpretationContext = {
    ...input,
    addresses: [
      { address: a, name: "User" },
      { address: b, name: "Router" },
      { address: token, name: "Proxy" },
      { address: second, name: "Implementation" },
    ],
    evidence: {
      ...input.evidence,
      calls: [
        root,
        {
          ...root,
          id: "0",
          parentId: "root",
          from: b,
          to: token,
          storageContext: token,
        },
        {
          ...root,
          id: "0.0",
          parentId: "0",
          type: "DELEGATECALL",
          from: token,
          to: second,
          storageContext: token,
        },
      ],
    },
    display: {
      ...input.display,
      calls: [
        {
          ...displayRoot,
          from: "User",
          to: "Router",
          storageContext: "Router",
        },
        {
          ...displayRoot,
          id: "0",
          parentId: "root",
          from: "Router",
          to: "Proxy",
          storageContext: "Proxy",
        },
        {
          ...displayRoot,
          id: "0.0",
          parentId: "0",
          kind: "DELEGATECALL",
          from: "Proxy",
          to: "Implementation",
          storageContext: "Proxy",
          action: "grant",
          args: [
            { name: "authorized", type: "address", value: "User" },
            { name: "enabled", type: "bool", value: true },
            { name: "data", type: "bytes" },
          ],
        },
      ],
    },
  };
  const result = callContextFacts(enriched, (name) => name);
  assert.equal(result.initiator, "User");
  assert.deepEqual(result.calls[2], {
    caller: "Router",
    via: ["Router"],
    contract: "Proxy",
    code: "Implementation",
    function: "grant",
    arguments: {
      "authorized (address)": "User",
      "enabled (bool)": true,
      "data (bytes)": "bytes",
    },
  });
  assert.equal(result.references[2]?.callId, "0.0");
  assert.ok(!JSON.stringify(result.calls).includes("0x"));
  const deep = {
    ...enriched,
    evidence: {
      ...enriched.evidence,
      calls: [
        ...enriched.evidence.calls,
        { ...root, id: "0.0.0", parentId: "0.0" },
        {
          ...root,
          id: "0.0.0.0",
          parentId: "0.0.0",
          type: "DELEGATECALL" as const,
        },
      ],
    },
    display: {
      ...enriched.display,
      calls: [
        ...enriched.display.calls,
        { ...displayRoot, id: "0.0.0", parentId: "0.0", action: "deeper" },
        {
          ...displayRoot,
          id: "0.0.0.0",
          parentId: "0.0.0",
          kind: "DELEGATECALL" as const,
          action: "deeperDelegate",
        },
      ],
    },
  };
  assert.deepEqual(
    callContextFacts(deep, (name) => name),
    result,
  );
});
