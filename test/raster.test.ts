import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagramRasterizer } from "../src/rendering/raster.js";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${Array.from({ length: 4096 }, (_, i) => `<rect x="${(i % 64) * 4}" y="${Math.floor(i / 64) * 4}" width="4" height="4" fill="rgb(${(i * 71) % 256},${(i * 137) % 256},${(i * 193) % 256})"/>`).join("")}</svg>`;

test("raster output preserves requested quality and scale when within budgets", async () => {
  const result = await new DiagramRasterizer().render(svg, {
    quality: 90,
    scale: 1,
  });
  assert.equal(result.scale, 1);
  assert.equal(result.quality, 90);
  assert.equal(result.width, 256);
});

test("pixel limit lowers resolution before rendering, including below CLI minimum scale", async () => {
  const result = await new DiagramRasterizer(1024).render(svg, {
    quality: 90,
    scale: 1,
  });
  assert.equal(result.scale, 0.125);
  assert.equal(result.width * result.height, 1024);
  assert.equal(result.quality, 90);
});

test("byte limit lowers JPEG quality before resolution and then falls back to resolution", async () => {
  const high = await new DiagramRasterizer().render(svg, {
    quality: 90,
    scale: 1,
  });
  const low = await new DiagramRasterizer().render(svg, {
    quality: 40,
    scale: 1,
  });
  assert.ok(high.jpeg.length > low.jpeg.length);
  const quality = await new DiagramRasterizer(
    50_000_000,
    Math.floor((high.jpeg.length + low.jpeg.length) / 2),
  ).render(svg, { quality: 90, scale: 1 });
  assert.equal(quality.scale, 1);
  assert.ok(quality.quality < 90);
  const budget = Math.floor(low.jpeg.length / 2);
  const smaller = await new DiagramRasterizer(50_000_000, budget).render(svg, {
    quality: 90,
    scale: 1,
  });
  assert.ok(smaller.scale < 1);
  assert.ok(smaller.jpeg.length <= budget);
});
