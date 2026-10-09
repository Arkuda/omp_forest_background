import { mkdir, readFile, writeFile } from "node:fs/promises";
import { encodePng } from "../src/png.ts";
import mistyForest, { meta } from "../src/vendor/misty-forest.ts";

// This is an asset build, not the extension's runtime. Keep the original scene
// factory and its ordered palette lookup intact; no reimplementation of trees.
const FRAME_COUNT = 64;
const TILES_PER_ROW = 8;
const SAMPLE_FPS = 2;
const DOTS = " ·•●";
const width = meta.cols * TILES_PER_ROW;
const height = meta.rows * (FRAME_COUNT / TILES_PER_ROW);
const assetsDirectory = new URL("../assets/", import.meta.url);

if (meta.cols !== 200 || meta.rows !== 100 || meta.palette.length !== 32) {
  throw new Error("The shader expects the original 200x100 scene and its 32-color palette.");
}

const render = mistyForest();
const color = new Uint8Array(meta.cols * meta.rows);
const stride = width * 4 + 1;
// The leading byte in each scanline is PNG filter 0. G and B stay zero.
const scanlines = Buffer.alloc(stride * height);
for (let frame = 0; frame < FRAME_COUNT; frame++) {
  const rows = render(frame / SAMPLE_FPS, { color }).split("\n");
  if (rows.length !== meta.rows || rows.some((row) => row.length !== meta.cols)) {
    throw new Error(`Original scene returned an unexpected grid at frame ${frame}.`);
  }
  const tileX = (frame % TILES_PER_ROW) * meta.cols;
  const tileY = Math.floor(frame / TILES_PER_ROW) * meta.rows;
  for (let y = 0; y < meta.rows; y++) {
    for (let x = 0; x < meta.cols; x++) {
      const dotStep = DOTS.indexOf(rows[y][x]);
      const paletteIndex = color[y * meta.cols + x];
      if (dotStep < 0 || paletteIndex >= meta.palette.length) {
        throw new Error(`Original scene returned an invalid descriptor at frame ${frame}, ${x},${y}.`);
      }
      const offset = (tileY + y) * stride + 1 + (tileX + x) * 4;
      scanlines[offset] = paletteIndex * 4 + dotStep;
      scanlines[offset + 3] = 255;
    }
  }
}

const palette = meta.palette.map((hex) => {
  const rgb = [1, 3, 5].map((offset) => `${Number.parseInt(hex.slice(offset, offset + 2), 16)}.0`);
  return `    float3(${rgb.join(", ")}) / 255.0`;
}).join(",\n");
const template = await readFile(new URL("forest.template.hlsl", assetsDirectory), "utf8");
if (!template.includes("{{PALETTE}}")) throw new Error("The shader source is missing its palette marker.");
await mkdir(assetsDirectory, { recursive: true });
await Promise.all([
  writeFile(new URL("forest-atlas.png", assetsDirectory), encodePng(scanlines, width, height)),
  writeFile(new URL("forest.hlsl", assetsDirectory), template.replace("{{PALETTE}}", palette)),
]);
console.log(`Generated ${width}x${height} packed atlas: ${FRAME_COUNT} original frames, ${SAMPLE_FPS}fps.`);
