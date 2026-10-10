import assert from "node:assert/strict";
import { test } from "node:test";
import type { SequenceNode } from "../src/decoding/compression.js";
import { StaticCallFilter } from "../src/rendering/static-calls.js";
import {
  SequenceDiagramBuilder,
  type DiagramCall,
  type DiagramInput,
} from "../src/rendering/sequence.js";

function fixture(failed = false): DiagramInput {
  const call = (
    id: string,
    parentId: string | null,
    from: string,
    to: string,
    kind: string,
    reverted = false,
  ): DiagramCall => ({
    id,
    parentId,
    from,
    to,
    kind,
    reverted,
    action: id,
    storageContext: to,
    valueWei: "0",
  });
  const node = (
    callId: string,
    children: SequenceNode[] = [],
  ): SequenceNode => ({ kind: "call", callId, children });
  const calls = [
    call("execute", null, "A", "B", "CALL"),
    call("read", "execute", "B", "Proxy", "STATICCALL"),
    call("delegate", "read", "Proxy", "Implementation", "DELEGATECALL"),
    call("nested", "delegate", "Proxy", "Oracle", "CALL", failed),
    call("balanceOf", "execute", "B", "Token", "CALL"),
  ];
  return {
    calls: new Map(calls.map((c) => [c.id, c])),
    sequence: [
      node("execute", [
        {
          kind: "repeat",
          id: "reads",
          count: 3,
          diffArgs: false,
          diffReturns: false,
          body: [node("read", [node("delegate", [node("nested")])])],
        },
        node("balanceOf"),
      ]),
    ],
  };
}

test("static subtrees and empty repeats disappear without changing evidence or CALLs named balanceOf", () => {
  const input = fixture();
  const before = structuredClone(input);
  const filtered = new StaticCallFilter().filter(input);
  assert.deepEqual(filtered.sequence, [
    {
      kind: "call",
      callId: "execute",
      children: [{ kind: "call", callId: "balanceOf", children: [] }],
    },
  ]);
  assert.deepEqual(input, before);
  assert.equal(filtered.calls, input.calls);
  const source = new SequenceDiagramBuilder().build(input);
  assert.doesNotMatch(source, /Proxy|Implementation|Oracle|Repeat/);
  assert.match(source, /balanceOf/);
});

test("caught failures retain the static ancestors and original endpoints", () => {
  const input = fixture(true);
  const filtered = new StaticCallFilter().filter(input);
  assert.deepEqual(filtered.sequence, input.sequence);
  const source = new SequenceDiagramBuilder().build(input);
  assert.match(source, /nested · revert/);
  assert.match(source, /Oracle/);
  assert.match(source, /Repeat ×3/);
});

test("failed static calls and transaction roots stay visible", () => {
  const input = fixture();
  const calls = new Map(input.calls);
  calls.set("read", { ...calls.get("read")!, reverted: true });
  const source = new SequenceDiagramBuilder().build({ ...input, calls });
  assert.match(source, /read ×3 · revert/);
  calls.set("execute", { ...calls.get("execute")!, kind: "STATICCALL" });
  calls.set("read", { ...calls.get("read")!, reverted: false });
  const filtered = new StaticCallFilter().filter({ ...input, calls });
  assert.deepEqual(filtered.sequence, [
    { kind: "call", callId: "execute", children: [] },
  ]);
});
