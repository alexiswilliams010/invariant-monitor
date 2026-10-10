import assert from "node:assert/strict";
import { test } from "node:test";
import { SelectedStateAdapter } from "../src/interpretation/selected-state.js";
import { TransactionInterpreter } from "../src/interpretation/interpreter.js";
import type {
  InterpretationAdapter,
  InterpretationContext,
} from "../src/interpretation/types.js";

const address = `0x${"ab".repeat(20)}` as const;
const other = `0x${"cd".repeat(20)}` as const;
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
      calls: [],
      stateDiff: { status: "collected", value: {} },
    },
    display: {
      schemaVersion: 3,
      chain: "ethereum",
      calls: [],
      sequence: [],
      storage: {
        status: "collected",
        changes: [
          {
            id: "s1",
            contract: "Contract_A",
            name: "shares",
            type: "uint256",
            before: "100",
            after: "120",
            delta: "20",
          },
          { id: "s2", contract: "Contract_A", name: "storage" },
          {
            id: "s3",
            contract: "Contract_B",
            name: "shares",
            before: "50",
            after: "40",
            delta: "-10",
          },
        ],
      },
    },
    addresses: [
      { address, name: "Contract_A" },
      { address: other, name: "Contract_B" },
    ],
  };
}

test("selected state preserves exact changes and transaction-level provenance without inventing asset flow", async () => {
  const input = context();
  const before = structuredClone(input);
  const adapter = new SelectedStateAdapter(
    "selected",
    { chainId: 1, address },
    ["shares"],
  );
  const result = await new TransactionInterpreter([adapter]).interpret(input);
  assert.equal(result.interpretations[0]?.facts.length, 1);
  const fact = result.interpretations[0]!.facts[0]!;
  assert.equal(fact.kind, "contract-state-change");
  if (fact.kind !== "contract-state-change") return;
  assert.equal(fact.change.delta, "20");
  assert.deepEqual(fact.evidence, {
    basis: "state-observed",
    position: { kind: "transaction" },
    references: [{ kind: "storage", changeId: "s1" }],
  });
  assert.deepEqual(input, before);
});

test("contract adapters only run for their configured chain and address", async () => {
  let runs = 0;
  const adapter: InterpretationAdapter = {
    id: "specific",
    scope: { kind: "contract", chainId: 8453, address },
    async interpret() {
      runs++;
      return { status: "interpreted", facts: [] };
    },
  };
  await new TransactionInterpreter([adapter]).interpret(context());
  assert.equal(runs, 0);
  const absent = { ...context(), addresses: [] };
  await new TransactionInterpreter([
    { ...adapter, scope: { kind: "contract", chainId: 1, address } },
  ]).interpret(absent);
  assert.equal(runs, 0);
  await new TransactionInterpreter([
    { ...adapter, scope: { kind: "contract", chainId: 1, address } },
  ]).interpret(context());
  assert.equal(runs, 1);
});

test("unknown storage remains unknown and an unavailable diff is not an empty observation", async () => {
  const adapter = new SelectedStateAdapter("selected", { chainId: 1, address });
  const result = await adapter.interpret(context());
  assert.equal(result.facts.length, 2);
  const unknown = result.facts[1]!;
  assert.equal(unknown.kind, "contract-state-change");
  if (unknown.kind === "contract-state-change")
    assert.deepEqual(unknown.change, {
      id: "s2",
      contract: "Contract_A",
      name: "storage",
    });
  const input = context();
  const unavailable = {
    ...input,
    display: {
      ...input.display,
      storage: { status: "unavailable" as const, changes: [] },
    },
  };
  assert.deepEqual(await adapter.interpret(unavailable), {
    status: "unavailable",
    facts: [],
  });
  const noFields = new SelectedStateAdapter(
    "none",
    { chainId: 1, address },
    [],
  );
  assert.deepEqual(await noFields.interpret(input), {
    status: "interpreted",
    facts: [],
  });
});

test("empty registration does nothing and ambiguous registration or unsupported facts fail", async () => {
  assert.deepEqual(
    (await new TransactionInterpreter([]).interpret(context())).interpretations,
    [],
  );
  const adapter = new SelectedStateAdapter("selected", { chainId: 1, address });
  assert.throws(() => new TransactionInterpreter([adapter, adapter]), /unique/);
  const result = await adapter.interpret(context());
  const invalid: InterpretationAdapter = {
    id: "invalid",
    scope: { kind: "standard" },
    async interpret() {
      return {
        ...result,
        facts: result.facts.map((fact) => ({
          ...fact,
          evidence: { ...fact.evidence, references: [] },
        })),
      };
    },
  };
  await assert.rejects(
    new TransactionInterpreter([invalid]).interpret(context()),
    /supporting evidence/,
  );
  await assert.rejects(
    new TransactionInterpreter([
      {
        ...invalid,
        async interpret() {
          return { ...result, status: "unavailable" };
        },
      },
    ]).interpret(context()),
    /Unresolved/,
  );
});
