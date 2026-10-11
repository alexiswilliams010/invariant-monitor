export function numericStateDelta(
  type: string,
  before: string | boolean,
  after: string | boolean,
): string | undefined {
  if (
    !/^u?int(?:[0-9]+)?$/.test(type) ||
    typeof before !== "string" ||
    typeof after !== "string" ||
    !/^-?\d+$/.test(before) ||
    !/^-?\d+$/.test(after)
  )
    return undefined;
  const delta = BigInt(after) - BigInt(before);
  return `${delta > 0n ? "+" : ""}${delta}`;
}
