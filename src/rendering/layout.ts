import type { Diagram } from "@d2lang/d2";

export function compactCallLayout(diagram: Diagram): Diagram {
  const result = structuredClone(diagram);
  const actors = result.shapes.filter((shape) => /^p\d+$/.test(shape.id));
  const header = Math.max(
    0,
    ...actors.map((shape) => shape.pos.y + shape.height),
  );
  const bands = result.shapes
    .filter((shape) => !/^p\d+$/.test(shape.id))
    .map((shape) => [shape.pos.y, shape.pos.y + 42] as const);
  const y = (value: number) =>
    value <= header
      ? value
      : Math.round(
          header +
            (value - header) * 0.45 +
            bands.reduce(
              (sum, [a, b]) =>
                sum +
                0.55 * Math.max(0, Math.min(value, b) - Math.max(header, a)),
              0,
            ),
        );
  for (const shape of [...result.shapes, result.root]) {
    const bottom = y(shape.pos.y + shape.height);
    shape.pos.y = y(shape.pos.y);
    shape.height = bottom - shape.pos.y;
  }
  for (const edge of result.connections) {
    for (const point of edge.route) if (point) point.y = y(point.y);
    edge.labelWidth = Math.ceil(edge.labelWidth * 1.2);
  }
  return result;
}
