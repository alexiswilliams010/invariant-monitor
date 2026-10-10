import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { encodeFunctionData, encodeFunctionResult, erc20Abi } from "viem";
import { OutcomeExporter } from "../src/interpretation/outcomes.js";
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
  assert.doesNotMatch(result.yaml, /0x|execute|logIndex|callId/);
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
