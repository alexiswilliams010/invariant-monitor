export interface AssetPaymentNet {
  readonly holder: string;
  readonly direction: "gain" | "loss";
  readonly quantity: string;
}

export interface AssetPaymentMovement {
  readonly from: string | null;
  readonly to: string | null;
}

export function assetPaymentSummary(
  initiator: string,
  totals: readonly AssetPaymentNet[],
  movements: readonly AssetPaymentMovement[],
  nativeSymbol: string,
): string[] {
  const sent = new Set<string>();
  const received = new Set<string>();
  for (const movement of movements) {
    if (movement.from === movement.to) continue;
    if (movement.from !== null) sent.add(movement.from);
    if (movement.to !== null) received.add(movement.to);
  }
  const holders = new Set([initiator, ...totals.map((entry) => entry.holder)]);
  return [...holders].map((holder) => {
    const entries = totals.filter((entry) => entry.holder === holder);
    const gains = entries.filter((entry) => entry.direction === "gain");
    const losses = entries.filter((entry) => entry.direction === "loss");
    const facts: string[] = [];
    if (gains.length)
      facts.push(`gained ${gains.map((entry) => entry.quantity).join(", ")}`);
    if (losses.length)
      facts.push(`lost ${losses.map((entry) => entry.quantity).join(", ")}`);
    if (!entries.length)
      facts.push(`no net token or ${nativeSymbol} movement recorded`);
    if (gains.length && !sent.has(holder))
      facts.push(`no token or ${nativeSymbol} payment recorded`);
    if (losses.length && !received.has(holder))
      facts.push(`no token or ${nativeSymbol} compensation recorded`);
    return `${holder === initiator ? `initiator (${holder})` : holder}: ${facts.join("; ")}`;
  });
}
