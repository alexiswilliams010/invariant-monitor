import assert from "node:assert/strict";
import { test } from "node:test";
import { ParticipantNameResolver } from "../src/rendering/names.js";
import type { DiagramCall } from "../src/rendering/sequence.js";

const delegation = (id: string, from: string, to: string): DiagramCall => ({
  id,
  parentId: "root",
  from,
  to,
  storageContext: from,
  kind: "DELEGATECALL",
  action: "execute",
  valueWei: "0",
  reverted: false,
});

test("names use all observed delegation, independently of visible or collapsed calls", () => {
  const calls = [
    delegation("one", "ProxyA", "Safe"),
    delegation("two", "ProxyB", "Safe"),
  ];
  const names = new ParticipantNameResolver().resolve({
    calls: new Map(calls.map((call) => [call.id, call])),
    sequence: [],
  });
  assert.deepEqual(
    [...names],
    [
      ["ProxyA", "Safe"],
      ["ProxyB", "Safe"],
    ],
  );
});

test("ambiguous targets and unknown implementation aliases do not replace names", () => {
  const calls = [
    delegation("one", "Proxy", "First"),
    delegation("two", "Proxy", "Second"),
    delegation("three", "NamedProxy", "Contract_A"),
    {
      ...delegation("four", "Library", "Implementation"),
      storageContext: "Other",
    },
  ];
  const names = new ParticipantNameResolver().resolve({
    calls: new Map(calls.map((call) => [call.id, call])),
    sequence: [],
  });
  assert.equal(names.size, 0);
});

test("token presentation names override implementation names without changing identities", () => {
  const call = delegation("one", "Proxy", "FiatToken");
  const calls = new Map([[call.id, call]]);
  const names = new ParticipantNameResolver().resolve({
    calls,
    sequence: [],
    preferredNames: new Map([["Proxy", "USDC"]]),
  });
  assert.equal(names.get("Proxy"), "USDC");
  assert.equal(call.from, "Proxy");
  assert.equal(call.to, "FiatToken");
});
