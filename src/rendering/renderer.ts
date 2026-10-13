import { D2 } from "@d2lang/d2";
import { DiagramRasterizer } from "./raster.js";
import { compactCallLayout } from "./layout.js";
import { SequenceDiagramBuilder, type DiagramInput } from "./sequence.js";

export interface ImageOptions {
  readonly quality: number;
  readonly scale: number;
}

export function validateImageOptions(options: ImageOptions): void {
  if (
    !Number.isInteger(options.quality) ||
    options.quality < 1 ||
    options.quality > 100 ||
    !Number.isFinite(options.scale) ||
    options.scale < 0.25 ||
    options.scale > 4
  )
    throw new Error("JPEG quality must be 1–100 and scale 0.25–4.");
}

export class D2SequenceRenderer {
  constructor(
    private readonly builder = new SequenceDiagramBuilder(),
    private readonly rasterizer = new DiagramRasterizer(),
  ) {}

  async render(
    input: DiagramInput,
    options: ImageOptions = { quality: 90, scale: 1 },
  ) {
    validateImageOptions(options);
    const { source, names, baselineRows, rows, stage } =
      this.builder.buildDocument(input);
    const d2 = new D2();
    let svg: string;
    try {
      const compiled = await d2.compile(source, {
        layout: "dagre",
        themeID: 0,
        pad: 24,
        scale: 1,
      });
      svg = await d2.render(
        compactCallLayout(compiled.diagram),
        compiled.renderOptions,
      );
    } finally {
      await d2.dispose();
    }
    const raster = await this.rasterizer.render(svg, options);
    return { source, names, svg, ...raster, baselineRows, rows, stage };
  }
}
