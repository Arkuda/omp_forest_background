import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeRgbaPng, encodePngAsync } from "./png.ts";
import { FRAME_COUNT, SAMPLE_FPS, TILES_PER_ROW, scenes } from "./scenes.ts";
import type { SceneId, SceneMetadata } from "./scenes.ts";

const CELL_PIXELS = 6;
type Rgb = readonly [number, number, number];

export interface GeneratedItermAssets {
  framePaths: string[];
  frameIntervalMs: number;
}

function rgb(hex: string): Rgb {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("The scene palette contains an invalid color.");
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

async function descriptors(scene: SceneId, meta: SceneMetadata): Promise<Buffer> {
  const width = meta.cols * TILES_PER_ROW;
  const height = meta.rows * (FRAME_COUNT / TILES_PER_ROW);
  const png = await readFile(new URL(`../assets/scenes/${scene}/atlas.png`, import.meta.url));
  const scanlines = await decodeRgbaPng(png, width, height);
  const packed = Buffer.allocUnsafe(width * height);
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 4;
      if (scanlines[offset] >= meta.palette.length * 4 || scanlines[offset + 1] !== 0
        || scanlines[offset + 2] !== 0 || scanlines[offset + 3] !== 255) {
        throw new Error(`The ${scene} atlas contains an invalid descriptor at ${x},${y}.`);
      }
      packed[y * width + x] = scanlines[offset];
    }
  }
  return packed;
}

/** Six-pixel glyphs use the Windows shader's cell aspect, pixel centers and AA width. */
function glyphRows(meta: SceneMetadata, brightness: number, background: Rgb): Buffer[] {
  const cellHeight = CELL_PIXELS * meta.cell;
  const glyphPixels = CELL_PIXELS * cellHeight;
  const coverage = Array.from({ length: 4 }, () => new Float64Array(glyphPixels));
  const edgeWidth = 0.5 / CELL_PIXELS;
  for (let y = 0; y < cellHeight; y++) {
    for (let x = 0; x < CELL_PIXELS; x++) {
      const distance = Math.hypot((x + 0.5) / CELL_PIXELS - 0.5, (y + 0.5) / CELL_PIXELS - meta.cell / 2);
      for (let step = 1; step <= 2; step++) {
        const radius = (step === 1 ? 0.30901936 : 0.43701937) * Math.sqrt(meta.cell);
        const t = Math.max(0, Math.min(1, (distance - radius + edgeWidth) / (2 * edgeWidth)));
        coverage[step][y * CELL_PIXELS + x] = 1 - t * t * (3 - 2 * t);
      }
      coverage[3][y * CELL_PIXELS + x] = 1;
    }
  }
  const ground = rgb(meta.ground);
  const templates = Buffer.allocUnsafe(meta.palette.length * 4 * glyphPixels * 4);
  const rows: Buffer[] = [];
  for (const [paletteIndex, hex] of meta.palette.entries()) {
    const color = rgb(hex);
    for (let step = 0; step < 4; step++) {
      const glyphOffset = (paletteIndex * 4 + step) * glyphPixels * 4;
      for (let pixel = 0; pixel < glyphPixels; pixel++) {
        const offset = glyphOffset + pixel * 4;
        for (let channel = 0; channel < 3; channel++) {
          const sceneColor = ground[channel] + (color[channel] - ground[channel]) * coverage[step][pixel];
          templates[offset + channel] = Math.min(255, Math.round(background[channel] + sceneColor * brightness));
        }
        templates[offset + 3] = 255;
      }
      for (let y = 0; y < cellHeight; y++) {
        const start = glyphOffset + y * CELL_PIXELS * 4;
        rows.push(templates.subarray(start, start + CELL_PIXELS * 4));
      }
    }
  }
  return rows;
}

/** Expand one offline baked scene into opaque, native iTerm2 background images. */
export async function generateItermAssets(
  outputDirectory: string,
  options: { scene: SceneId; brightness: number; backgroundColor: Rgb },
): Promise<GeneratedItermAssets> {
  if (!Number.isFinite(options.brightness) || options.brightness < 0 || options.brightness > 0.3) {
    throw new Error("Forest brightness must be a finite number between 0 and 0.3.");
  }
  if (options.backgroundColor.length !== 3 || options.backgroundColor.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new Error("The iTerm2 background color must contain three RGB bytes.");
  }
  const meta = scenes[options.scene];
  const atlasWidth = meta.cols * TILES_PER_ROW;
  const cellHeight = CELL_PIXELS * meta.cell;
  const width = meta.cols * CELL_PIXELS;
  const height = meta.rows * cellHeight;
  const atlas = await descriptors(options.scene, meta);
  const templates = glyphRows(meta, options.brightness, options.backgroundColor);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const stride = width * 4 + 1;
  // One raw frame throughout: filter bytes stay zero, all RGBA pixels are overwritten.
  const scanlines = Buffer.alloc(stride * height);
  const framePaths: string[] = [];
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const tileX = (frame % TILES_PER_ROW) * meta.cols;
    const tileY = Math.floor(frame / TILES_PER_ROW) * meta.rows;
    for (let y = 0; y < height; y++) {
      const descriptorRow = (tileY + Math.floor(y / cellHeight)) * atlasWidth + tileX;
      const glyphRow = y % cellHeight;
      const scanline = y * stride + 1;
      for (let x = 0; x < meta.cols; x++) {
        templates[atlas[descriptorRow + x] * cellHeight + glyphRow].copy(scanlines, scanline + x * CELL_PIXELS * 4);
      }
    }
    // Async zlib and file I/O let omp render between frames; never queue 64 raw buffers.
    const png = await encodePngAsync(scanlines, width, height);
    const path = resolve(directory, `${options.scene}-frame-${String(frame).padStart(2, "0")}.png`);
    await writeFile(path, png);
    framePaths.push(path);
  }
  return { framePaths, frameIntervalMs: 1000 / SAMPLE_FPS };
}
