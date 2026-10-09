import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeRgbaPng, encodePngAsync } from "./png.ts";
import { meta } from "./vendor/misty-forest.ts";

const FRAME_COUNT = 64;
const TILES_PER_ROW = 8;
const COLS = 200;
const ROWS = 100;
const CELL_PIXELS = 6;
const WIDTH = COLS * CELL_PIXELS;
const HEIGHT = ROWS * CELL_PIXELS;
const ATLAS_WIDTH = COLS * TILES_PER_ROW;
const ATLAS_HEIGHT = ROWS * (FRAME_COUNT / TILES_PER_ROW);

type Rgb = readonly [number, number, number];

export interface GeneratedItermAssets {
  framePaths: string[];
  frameIntervalMs: number;
}

function rgb(hex: string): Rgb {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("The original forest palette contains an invalid color.");
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

async function descriptors(): Promise<Buffer> {
  const png = await readFile(new URL("../assets/forest-atlas.png", import.meta.url));
  const scanlines = await decodeRgbaPng(png, ATLAS_WIDTH, ATLAS_HEIGHT);
  const packed = Buffer.allocUnsafe(ATLAS_WIDTH * ATLAS_HEIGHT);
  const stride = ATLAS_WIDTH * 4 + 1;
  for (let y = 0; y < ATLAS_HEIGHT; y++) {
    for (let x = 0; x < ATLAS_WIDTH; x++) {
      const offset = y * stride + 1 + x * 4;
      if (scanlines[offset] >= meta.palette.length * 4 || scanlines[offset + 1] !== 0
        || scanlines[offset + 2] !== 0 || scanlines[offset + 3] !== 255) {
        throw new Error(`The forest atlas contains an invalid descriptor at ${x},${y}.`);
      }
      packed[y * ATLAS_WIDTH + x] = scanlines[offset];
    }
  }
  return packed;
}

/** Six-pixel glyphs use the Windows shader's pixel-center sampling and AA width. */
function glyphRows(brightness: number, background: Rgb): Buffer[] {
  const coverage = Array.from({ length: 4 }, () => new Float64Array(CELL_PIXELS * CELL_PIXELS));
  const edgeWidth = 0.5 / CELL_PIXELS;
  for (let y = 0; y < CELL_PIXELS; y++) {
    for (let x = 0; x < CELL_PIXELS; x++) {
      const distance = Math.hypot((x + 0.5) / CELL_PIXELS - 0.5, (y + 0.5) / CELL_PIXELS - 0.5);
      for (let step = 1; step <= 2; step++) {
        const radius = step === 1 ? 0.30901936 : 0.43701937;
        const t = Math.max(0, Math.min(1, (distance - radius + edgeWidth) / (2 * edgeWidth)));
        coverage[step][y * CELL_PIXELS + x] = 1 - t * t * (3 - 2 * t);
      }
      coverage[3][y * CELL_PIXELS + x] = 1;
    }
  }
  const ground = rgb(meta.ground);
  const templates = Buffer.allocUnsafe(meta.palette.length * 4 * CELL_PIXELS * CELL_PIXELS * 4);
  const rows: Buffer[] = [];
  for (const [paletteIndex, hex] of meta.palette.entries()) {
    const color = rgb(hex);
    for (let step = 0; step < 4; step++) {
      const glyphOffset = (paletteIndex * 4 + step) * CELL_PIXELS * CELL_PIXELS * 4;
      for (let pixel = 0; pixel < CELL_PIXELS * CELL_PIXELS; pixel++) {
        const offset = glyphOffset + pixel * 4;
        for (let channel = 0; channel < 3; channel++) {
          const forest = ground[channel] + (color[channel] - ground[channel]) * coverage[step][pixel];
          templates[offset + channel] = Math.min(255, Math.round(background[channel] + forest * brightness));
        }
        templates[offset + 3] = 255;
      }
      for (let y = 0; y < CELL_PIXELS; y++) {
        const start = glyphOffset + y * CELL_PIXELS * 4;
        rows.push(templates.subarray(start, start + CELL_PIXELS * 4));
      }
    }
  }
  return rows;
}

/** Expand the baked original scene into opaque, native iTerm2 background images. */
export async function generateItermAssets(
  outputDirectory: string,
  options: { brightness: number; backgroundColor: Rgb },
): Promise<GeneratedItermAssets> {
  if (!Number.isFinite(options.brightness) || options.brightness < 0 || options.brightness > 0.3) {
    throw new Error("Forest brightness must be a finite number between 0 and 0.3.");
  }
  if (options.backgroundColor.length !== 3 || options.backgroundColor.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new Error("The iTerm2 background color must contain three RGB bytes.");
  }
  if (meta.cols !== COLS || meta.rows !== ROWS || meta.palette.length !== 32) {
    throw new Error("The forest images expect the original 200x100 scene and its 32-color palette.");
  }
  const atlas = await descriptors();
  const templates = glyphRows(options.brightness, options.backgroundColor);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const stride = WIDTH * 4 + 1;
  // One raw frame throughout: filter bytes stay zero, all RGBA pixels are overwritten.
  const scanlines = Buffer.alloc(stride * HEIGHT);
  const framePaths: string[] = [];
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const tileX = (frame % TILES_PER_ROW) * COLS;
    const tileY = Math.floor(frame / TILES_PER_ROW) * ROWS;
    for (let y = 0; y < HEIGHT; y++) {
      const descriptorRow = (tileY + Math.floor(y / CELL_PIXELS)) * ATLAS_WIDTH + tileX;
      const glyphRow = y % CELL_PIXELS;
      const scanline = y * stride + 1;
      for (let x = 0; x < COLS; x++) {
        templates[atlas[descriptorRow + x] * CELL_PIXELS + glyphRow].copy(scanlines, scanline + x * CELL_PIXELS * 4);
      }
    }
    // Async zlib and file I/O let omp render between frames; never queue 64 raw buffers.
    const png = await encodePngAsync(scanlines, WIDTH, HEIGHT);
    const path = resolve(directory, `forest-frame-${String(frame).padStart(2, "0")}.png`);
    await writeFile(path, png);
    framePaths.push(path);
  }
  return { framePaths, frameIntervalMs: 500 };
}
