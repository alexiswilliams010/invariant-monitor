import assert from "node:assert/strict";
import { test } from "node:test";
import { compactAssetLabel } from "../src/rendering/amounts.js";
import {
  SequenceDiagramBuilder,
  type DiagramCall,
} from "../src/rendering/sequence.js";

test("image amounts are compact and mark rounding without changing asset labels", () => {
  assert.equal(
    compactAssetLabel("2722.896986125761481022 wstETH"),
    "≈2,723 wstETH",
  );
  assert.equal(compactAssetLabel("8.23 USDC"), "8.23 USDC");
  assert.equal(
    compactAssetLabel("900719925474099312345 units Token"),
    "≈900,700,000,000,000,000,000 units Token",
  );
  assert.equal(
    compactAssetLabel("0.000000000000000001 Token"),
    "0.000000000000000001 Token",
  );
});

test("only adjacent same-endpoint sibling assets combine; unplaced-only lanes disappear", () => {
  const make = (
    id: string,
    from: string,
    to: string,
    action: string,
  ): DiagramCall => ({
    id,
    parentId: "root",
    from,
    to,
    action,
    kind: "CALL",
    valueWei: "0",
    storageContext: null,
    reverted: false,
    assetMovement: true,
  });
  const calls = new Map<string, DiagramCall>([
    [
      "root",
      {
        ...make("root", "Sender", "Vault", "flashLoan"),
        parentId: null,
        assetMovement: false,
      },
    ],
    ["a", make("a", "Vault", "Borrower", "10 A")],
    ["b", make("b", "Vault", "Borrower", "20 B")],
    ["c", make("c", "Vault", "Other", "30 C")],
    ["d", make("d", "Vault", "Borrower", "40 D")],
    ["unplaced", make("unplaced", "MintOnly", "RecipientOnly", "50 E")],
  ]);
  const source = new SequenceDiagramBuilder({ mode: "always" }).build({
    calls,
    unplacedMovements: ["unplaced"],
    sequence: [
      {
        kind: "call",
        callId: "root",
        children: ["a", "b", "c", "d"].map((callId) => ({
          kind: "call",
          callId,
          children: [],
        })),
      },
    ],
  });
  assert.match(source, /"10 A\\n20 B"/);
  assert.equal(source.match(/ -> /g)?.length, 3);
  assert.equal(source.match(/ <-> /g)?.length, 1);
  assert.doesNotMatch(source, /MintOnly|RecipientOnly|unplaced|stroke-dash/);
  assert.match(source, /p1 -> p3: "30 C"/);
  assert.match(source, /p1 -> p2: "40 D"/);
});

test("adaptive diagrams simplify only above 250 baseline rows and count repeats once", () => {
  const root: DiagramCall = {
    id: "root",
    parentId: null,
    from: "Sender",
    to: "Vault",
    action: "execute",
    kind: "CALL",
    valueWei: "0",
    storageContext: null,
    reverted: false,
  };
  const calls = new Map<string, DiagramCall>([["root", root]]);
  const children = Array.from({ length: 249 }, (_, index) => {
    const id = `asset-${index}`;
    calls.set(id, {
      ...root,
      id,
      parentId: "root",
      from: "Vault",
      to: "Recipient",
      action: "1.234567 Asset",
      assetMovement: true,
    });
    return { kind: "call" as const, callId: id, children: [] };
  });
  const input = (count: number) => ({
    calls,
    sequence: [
      {
        kind: "call" as const,
        callId: "root",
        children: children.slice(0, count),
      },
    ],
  });
  const builder = new SequenceDiagramBuilder();
  const at = builder.buildDocument(input(248));
  assert.equal(at.baselineRows, 250);
  assert.equal(at.simplified, false);
  assert.equal(at.source.match(/ -> /g)?.length, 250);
  assert.match(at.source, /stroke-dash/);
  assert.match(at.source, /1\.234567 Asset/);
  const above = builder.buildDocument(input(249));
  assert.equal(above.baselineRows, 251);
  assert.equal(above.simplified, true);
  assert.doesNotMatch(above.source, /stroke-dash/);
  assert.match(above.source, /≈1\.235 Asset/);
  const repeated = builder.buildDocument({
    calls,
    sequence: [
      {
        kind: "repeat",
        id: "repeat",
        count: 1000,
        diffArgs: false,
        diffReturns: false,
        body: input(248).sequence,
      },
    ],
  });
  assert.equal(repeated.baselineRows, 250);
  assert.equal(repeated.simplified, false);
  assert.equal(
    new SequenceDiagramBuilder({ mode: "never" }).buildDocument(input(249))
      .simplified,
    false,
  );
});

test("unknown calls survive compact stage and are filtered only if it still exceeds the threshold", () => {
  const calls = new Map<string, DiagramCall>();
  calls.set("root", {
    id: "root",
    parentId: null,
    from: "Sender",
    to: "Vault",
    action: "execute",
    kind: "CALL",
    valueWei: "0",
    storageContext: null,
    reverted: false,
  });
  const children = Array.from({ length: 260 }, (_, i) => {
    const id = `unknown-${i}`;
    calls.set(id, {
      ...calls.get("root")!,
      id,
      parentId: "root",
      from: "Vault",
      to: "Other",
      action: "call",
    });
    return { kind: "call" as const, callId: id, children: [] };
  });
  const make = (n: number) => ({
    calls,
    sequence: [
      { kind: "call" as const, callId: "root", children: children.slice(0, n) },
    ],
  });
  const compact = new SequenceDiagramBuilder().buildDocument(make(130));
  assert.equal(compact.stage, "compact");
  assert.equal(compact.rows, 131);
  assert.match(compact.source, /"call"/);
  const filtered = new SequenceDiagramBuilder().buildDocument(make(260));
  assert.equal(filtered.stage, "filtered");
  assert.equal(filtered.rows, 1);
  assert.match(filtered.source, /"execute"/);
  assert.doesNotMatch(filtered.source, /"call"/);
});
