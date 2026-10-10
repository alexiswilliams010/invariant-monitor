import type { Diagram } from "@d2lang/d2";

export function compactCallLayout(diagram: Diagram): Diagram {
  const result = structuredClone(diagram);
  const left = result.shapes.filter((shape) => shape.id.endsWith(".a"));
  const right = result.shapes.filter((shape) => shape.id.endsWith(".b"));
  const leftWidth = Math.max(
    160,
    ...left.map(
      (shape) => ("labelWidth" in shape ? shape.labelWidth : 0) * 1.25 + 24,
    ),
  );
  const rightWidth = Math.max(
    160,
    ...right.map(
      (shape) => ("labelWidth" in shape ? shape.labelWidth : 0) * 1.25 + 24,
    ),
  );
  const gap = Math.max(
    240,
    ...result.connections.map((edge) => edge.labelWidth * 1.3 + 48),
  );
  const width = Math.ceil(leftWidth + gap + rightWidth + 32);
  const place = (parent: string, top: number): number => {
    let y = top;
    const children = result.shapes.filter((shape) => {
      const dot = shape.id.lastIndexOf(".");
      return (dot < 0 ? "" : shape.id.slice(0, dot)) === parent;
    });
    for (const shape of children) {
      shape.pos = { x: 0, y };
      shape.width = width;
      if (/(^|\.)r\d+$/.test(shape.id)) {
        const a = result.shapes.find((item) => item.id === `${shape.id}.a`)!;
        const b = result.shapes.find((item) => item.id === `${shape.id}.b`)!;
        a.pos = { x: 16, y: y + 4 };
        a.width = Math.ceil(leftWidth);
        b.pos = { x: Math.ceil(16 + leftWidth + gap), y: y + 4 };
        b.width = Math.ceil(rightWidth);
        const edge = result.connections.find(
          (item) => item.src === a.id && item.dst === b.id,
        )!;
        edge.labelWidth = Math.ceil(edge.labelWidth * 1.3);
        const height =
          Math.max(
            "labelHeight" in a ? a.labelHeight : 0,
            "labelHeight" in b ? b.labelHeight : 0,
            edge.labelHeight,
          ) + 8;
        edge.route = [
          { x: 16 + leftWidth, y: y + height / 2 },
          { x: b.pos.x, y: y + height / 2 },
        ];
        shape.height = height;
      } else {
        shape.height =
          place(
            shape.id,
            y + ("labelHeight" in shape ? shape.labelHeight : 0) + 16,
          ) -
          y +
          4;
      }
      y += shape.height + 8;
    }
    return y;
  };
  result.root.width = width;
  result.root.height = place("", 0);
  return result;
}
