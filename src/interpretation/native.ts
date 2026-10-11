import type { CallFrame } from "../collection/types.js";

export function nativeTransfers(calls: readonly CallFrame[]) {
  const movements: {
    from: string;
    to: string;
    amountWei: string;
    callId: string;
  }[] = [];
  const totals = new Map<string, bigint>();
  for (const call of calls) {
    if (
      call.reverted ||
      call.readOnly ||
      !call.to ||
      !["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"].includes(call.type)
    )
      continue;
    const amount = BigInt(call.value);
    const from = call.from.toLowerCase();
    const to = call.to.toLowerCase();
    if (amount === 0n || from === to) continue;
    movements.push({ from, to, amountWei: amount.toString(), callId: call.id });
    totals.set(from, (totals.get(from) ?? 0n) - amount);
    totals.set(to, (totals.get(to) ?? 0n) + amount);
  }
  return {
    movements,
    totals: [...totals].filter(([, amount]) => amount !== 0n),
  };
}
