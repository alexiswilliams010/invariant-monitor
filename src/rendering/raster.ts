import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

export class DiagramRasterizer {
  constructor(
    private readonly maxPixels = 50_000_000,
    private readonly maxBytes = 8_000_000,
  ) {
    if (
      ![maxPixels, maxBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error("Image limits must be positive integers.");
  }

  async render(svg: string, requested: { scale: number; quality: number }) {
    const measure = new Resvg(svg);
    let scale = requested.scale;
    const fits = () =>
      Math.max(1, Math.ceil(measure.width * scale)) *
        Math.max(1, Math.ceil(measure.height * scale)) <=
      this.maxPixels;
    while (!fits()) scale /= 2;
    for (;;) {
      const raster = new Resvg(svg, {
        fitTo: { mode: "zoom", value: scale },
        background: "white",
        font: { defaultFontFamily: "Arial" },
      }).render();
      const encode = (quality: number) =>
        sharp(raster.pixels, {
          raw: { width: raster.width, height: raster.height, channels: 4 },
        })
          .jpeg({ quality, chromaSubsampling: "4:4:4" })
          .toBuffer();
      let quality = requested.quality;
      const floor = Math.min(40, quality);
      for (;;) {
        const jpeg = await encode(quality);
        if (jpeg.length <= this.maxBytes)
          return {
            jpeg,
            width: raster.width,
            height: raster.height,
            scale,
            quality,
          };
        if (quality === floor) break;
        quality = Math.max(floor, quality - 10);
      }
      if (raster.width <= 1 || raster.height <= 1)
        throw new Error("Cannot fit diagram within JPEG byte limit.");
      scale /= 2;
    }
  }
}
