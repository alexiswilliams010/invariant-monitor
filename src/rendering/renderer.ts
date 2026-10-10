import { D2 } from "@d2lang/d2";
import { Resvg } from "@resvg/resvg-js";
import { compactCallLayout } from "./layout.js";
import sharp from "sharp";
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
  constructor(private readonly builder = new SequenceDiagramBuilder()) {}

  async render(
    input: DiagramInput,
    options: ImageOptions = { quality: 90, scale: 1 },
  ) {
    validateImageOptions(options);
    const { source, names } = this.builder.buildDocument(input);
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
    const rasterizer = new Resvg(svg, {
      fitTo: { mode: "zoom", value: options.scale },
      background: "white",
      font: { defaultFontFamily: "Arial" },
    });
    if (
      Math.ceil(rasterizer.width * options.scale) *
        Math.ceil(rasterizer.height * options.scale) >
      50_000_000
    )
      throw new Error("JPEG exceeds 50 million pixels; reduce --scale.");
    const pixels = rasterizer.render();
    const jpeg = await sharp(pixels.pixels, {
      raw: { width: pixels.width, height: pixels.height, channels: 4 },
    })
      .jpeg({ quality: options.quality, chromaSubsampling: "4:4:4" })
      .toBuffer({ resolveWithObject: true });
    return {
      source,
      names,
      svg,
      jpeg: jpeg.data,
      width: jpeg.info.width,
      height: jpeg.info.height,
    };
  }
}
