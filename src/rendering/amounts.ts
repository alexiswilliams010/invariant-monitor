export function compactAssetLabel(label: string): string {
  return label.replace(/^(\d+(?:\.\d+)?) /, (match, quantity: string) => {
    const value = Number(quantity);
    if (!Number.isFinite(value)) return match;
    const formatted = value.toLocaleString("en-US", {
      maximumSignificantDigits: 4,
      useGrouping: true,
    });
    const normalize = (text: string) =>
      text
        .replaceAll(",", "")
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "");
    return `${normalize(formatted) === normalize(quantity) ? "" : "≈"}${formatted} `;
  });
}
