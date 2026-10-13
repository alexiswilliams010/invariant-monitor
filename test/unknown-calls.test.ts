import assert from "node:assert/strict";
import { test } from "node:test";
import type { SequenceNode } from "../src/decoding/compression.js";
import type { DiagramCall, DiagramInput } from "../src/rendering/sequence.js";
import { UnknownCallFilter } from "../src/rendering/unknown-calls.js";

function fixture(reentry = false): DiagramInput {
  const call = (
    id: string,
    parentId: string | null,
    from: string,
    to: string,
    action = "call",
  ): DiagramCall => ({
    id,
    parentId,
    from,
    to,
    storageContext: to,
    action,
    kind: "CALL",
    valueWei: "0",
    reverted: false,
  });
  return {
    calls: new Map([
      ["root", call("root", null, "Sender", "A")],
      ["middle", call("middle", "root", "A", "B")],
      [
        "child",
        call(
          "child",
          "middle",
          "B",
          reentry ? "A" : "C",
          reentry ? "call" : "swap",
        ),
      ],
    ]),
    sequence: [
      {
        kind: "call",
        callId: "root",
        children: [
          {
            kind: "call",
            callId: "middle",
            children: [{ kind: "call", callId: "child", children: [] }],
          },
        ],
      },
    ],
  };
}

test("unknown intermediate calls disappear without rewriting visible child endpoints", () => {
  const input = fixture();
  const result = new UnknownCallFilter().filter(input);
  assert.deepEqual(result.sequence, [
    {
      kind: "call",
      callId: "root",
      children: [{ kind: "call", callId: "child", children: [] }],
    },
  ]);
  assert.equal(result.calls.get("child")!.from, "B");
  assert.equal(result.calls.get("child")!.to, "C");
  assert.equal(result.calls, input.calls);
});

test("unknown callback and reentry paths remain, including the active outer call", () => {
  const input = fixture(true);
  assert.deepEqual(
    new UnknownCallFilter().filter(input).sequence,
    input.sequence,
  );
});

test("initiator calls and asset movements remain; empty repeat blocks disappear", () => {
  const input = fixture();
  input.calls.get("middle")!.from = "Sender";
  input.calls.get("child")!.action = "call";
  input.calls.get("child")!.assetMovement = true;
  assert.deepEqual(
    new UnknownCallFilter().filter(input).sequence,
    input.sequence,
  );
  const repeated = fixture();
  const root = repeated.sequence[0] as Extract<SequenceNode, { kind: "call" }>;
  const children: SequenceNode[] = [
    {
      kind: "repeat",
      id: "r",
      count: 3,
      diffArgs: false,
      diffReturns: false,
      body: [{ kind: "call", callId: "middle", children: [] }],
    },
  ];
  assert.deepEqual(
    new UnknownCallFilter().filter({
      ...repeated,
      sequence: [{ ...root, children }],
    }).sequence,
    [{ kind: "call", callId: "root", children: [] }],
  );
});
