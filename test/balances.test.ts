import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, encodeFunctionResult, erc20Abi } from "viem";
import type { CallFrame } from "../src/collection/types.js";
import {
  TokenBalanceReader,
  balanceKey,
  balancePercentage,
} from "../src/interpretation/balances.js";
const asset = `0x${"aa".repeat(20)}` as const;
const holder = `0x${"bb".repeat(20)}` as const;
const impl = `0x${"cc".repeat(20)}` as const;
function read(id: string, amount = 20n): CallFrame {
  return {
    id,
    parentId: "root",
    traceAddress: [Number(id)],
    type: "STATICCALL",
    from: holder,
    to: asset,
    storageContext: asset,
    input: encodeFunctionData({
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    }),
    output: encodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      result: amount,
    }),
    value: "0",
    reverted: false,
    readOnly: true,
  };
}
const reader = new TokenBalanceReader();
test("balance reads before token writes provide a denominator, later reads do not", () => {
  const write = {
    ...read("1"),
    type: "CALL" as const,
    input: "0x" as const,
    readOnly: false,
  };
  assert.equal(
    reader
      .read([read("0"), write, read("2", 0n)])
      .get(balanceKey(asset, holder))?.amount,
    "20",
  );
  assert.equal(reader.read([write, read("2")]).size, 0);
});
test("proxy reads use the proxy identity and accept delegate forwarding only", () => {
  const proxy = read("0");
  const delegate = {
    ...read("1"),
    parentId: "0",
    type: "DELEGATECALL" as const,
    from: asset,
    to: impl,
  };
  assert.equal(
    reader.read([proxy, delegate]).get(balanceKey(asset, holder))?.amount,
    "20",
  );
  const external = {
    ...delegate,
    type: "STATICCALL" as const,
    storageContext: impl,
  };
  assert.equal(
    reader.read([proxy, external]).has(balanceKey(asset, holder)),
    false,
  );
});
test("conflicting, reverted, malformed and ordinary CALL reads are excluded", () => {
  assert.equal(reader.read([read("0"), read("1", 21n)]).size, 0);
  for (const call of [
    { ...read("0"), reverted: true },
    { ...read("0"), output: "0x" as const },
    { ...read("0"), type: "CALL" as const, readOnly: false },
    { ...read("0"), input: `${read("0").input}00` as const },
  ])
    assert.equal(reader.read([call]).size, 0);
});
test("percentages preserve exact arithmetic and do not round partial drains to 100%", () => {
  assert.equal(balancePercentage(-20n, 20n), "-100%");
  assert.equal(balancePercentage(10n, 20n), "+50%");
  assert.equal(balancePercentage(1n, 0n), "new balance");
  assert.equal(balancePercentage(-1n, 0n), undefined);
  assert.equal(balancePercentage(-21n, 20n), undefined);
  assert.equal(balancePercentage(-999999n, 1000000n), "~-99.99%");
  assert.equal(balancePercentage(1n, 1000000n), "+<0.01%");
  assert.equal(balancePercentage(-(2n ** 200n), 2n ** 200n), "-100%");
});
