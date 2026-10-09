import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { inflateSync } from "node:zlib";
import { generateItermAssets } from "../src/iterm-assets.ts";
import type { GeneratedItermAssets } from "../src/iterm-assets.ts";
import { decodeRgbaPng } from "../src/png.ts";
import { DEFAULT_SCENE, FRAME_COUNT, TILES_PER_ROW, scenes } from "../src/scenes.ts";
import mistyForest, { meta } from "../src/vendor/misty-forest.ts";

const background = [253, 17, 31] as const;
const brightness = 0.16;

interface DecodedImage {
  width: number;
  height: number;
  raw: Buffer;
  stride: number;
}
const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omp-forest-frames-"));
  directories.push(path);
  return path;
}

// Read the generated PNG as a consumer, independently of the product's codec.
function image(png: Buffer): DecodedImage {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.toString("ascii", 12, 16)).toBe("IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
  const compressed: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * 4 + 1;
  expect(raw.length).toBe(stride * height);
  for (let y = 0; y < height; y++) expect(raw[y * stride]).toBe(0);
  return { width, height, raw, stride };
}

function pixel(decoded: DecodedImage, x: number, y: number): number[] {
  const offset = y * decoded.stride + 1 + x * 4;
  return [...decoded.raw.subarray(offset, offset + 4)];
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function additive(color: number[]): number[] {
  return color.map((channel, index) => Math.min(255, Math.round(background[index] + channel * brightness))).concat(255);
}

afterAll(async () => {
  for (const path of directories) await rm(path, { recursive: true, force: true });
});

describe("native original-scene images", () => {
  let generated: GeneratedItermAssets;
  beforeAll(async () => {
    generated = await generateItermAssets(await directory(), { scene: DEFAULT_SCENE, brightness, backgroundColor: background });
  }, 60_000);

  test("exports 64 absolute, opaque 1200x600 images at the original sample cadence", async () => {
    expect(generated.frameIntervalMs).toBe(500);
    expect(generated.framePaths.length).toBe(64);
    expect(new Set(generated.framePaths).size).toBe(64);
    let first: Buffer | undefined;
    let last: Buffer | undefined;
    for (const [index, path] of generated.framePaths.entries()) {
      expect(isAbsolute(path)).toBe(true);
      const png = await readFile(path);
      const decoded = image(png);
      expect([decoded.width, decoded.height]).toEqual([1200, 600]);
      // Every pixel is opaque; alpha cannot wash out the dim native background.
      let opaque = true;
      for (let y = 0; y < decoded.height; y++) {
        for (let x = 0; x < decoded.width; x++) {
          if (decoded.raw[y * decoded.stride + 1 + x * 4 + 3] !== 255) opaque = false;
        }
      }
      expect(opaque).toBe(true);
      if (index === 0) first = png;
      if (index === 63) last = png;
    }
    expect(first!.equals(last!)).toBe(false);
  }, 60_000);

  test("retains original palette, solid/empty classes, antialiased circles, and additive clipping", async () => {
    const render = mistyForest();
    const ground = rgb(meta.ground);
    const colors = new Uint8Array(meta.cols * meta.rows);
    // Palette quantization caches the first match per bin; replay the atlas's sampling order.
    for (let frame = 0; frame < 64; frame++) {
      const cells = render(frame / 2, { color: colors }).split("\n");
      if (frame !== 0 && frame !== 63) continue;
      const decoded = image(await readFile(generated.framePaths[frame]));
      const found = new Set<number>();
      let clipped = false;
      for (let y = 0; y < meta.rows; y++) {
        for (let x = 0; x < meta.cols; x++) {
          const step = " ·•●".indexOf(cells[y][x]);
          const color = rgb(meta.palette[colors[y * meta.cols + x]]);
          const center = pixel(decoded, x * 6 + 2, y * 6 + 2);
          const expected = additive(step === 0 ? ground : color);
          if (!center.every((channel, index) => channel === expected[index])) {
            throw new Error(`Original frame ${frame}, cell ${x},${y} has the wrong native color.`);
          }
          if (step !== 0 && background[0] + color[0] * brightness > 255) clipped = true;
          if (found.has(step) || ((step === 1 || step === 2) && color[1] - ground[1] < 100)) continue;
          found.add(step);
          let greenSum = 0;
          for (let py = 0; py < 6; py++) {
            for (let px = 0; px < 6; px++) {
              const value = pixel(decoded, x * 6 + px, y * 6 + py);
              if (step === 0 || step === 3) expect(value).toEqual(expected);
              greenSum += value[1] - additive(ground)[1];
            }
          }
          if (step === 1 || step === 2) {
            expect(pixel(decoded, x * 6, y * 6)).toEqual(additive(ground));
            const area = greenSum / ((color[1] - ground[1]) * brightness);
            expect(area).toBeGreaterThan(step === 1 ? 9 : 19);
            expect(area).toBeLessThan(step === 1 ? 13 : 24);
            if (step === 1) expect(pixel(decoded, x * 6 + 2, y * 6)).toEqual(additive(ground));
            else {
              const edge = pixel(decoded, x * 6 + 2, y * 6)[1];
              expect(edge).toBeGreaterThan(additive(ground)[1]);
              expect(edge).toBeLessThan(expected[1]);
            }
          }
        }
      }
      expect(clipped).toBe(true);
      expect(found.has(1)).toBe(true);
      expect(found.has(2)).toBe(true);
      expect(found.has(3)).toBe(true);
    }
  }, 60_000);

  test("zero brightness produces exactly the unmodified profile background", async () => {
    const base = [9, 21, 33] as const;
    const result = await generateItermAssets(await directory(), { scene: DEFAULT_SCENE, brightness: 0, backgroundColor: base });
    for (const frame of [0, 63]) {
      const decoded = image(await readFile(result.framePaths[frame]));
      let unchanged = true;
      for (let y = 0; y < decoded.height; y++) {
        for (let x = 0; x < decoded.width; x++) {
          const offset = y * decoded.stride + 1 + x * 4;
          if (decoded.raw[offset] !== base[0] || decoded.raw[offset + 1] !== base[1]
            || decoded.raw[offset + 2] !== base[2] || decoded.raw[offset + 3] !== 255) unchanged = false;
        }
      }
      expect(unchanged).toBe(true);
    }
  }, 60_000);
});

test("expands a different scene's larger palette across tile-row boundaries and the final sample", async () => {
  const scene = "tokyo-rain";
  const selected = scenes[scene];
  const generated = await generateItermAssets(await directory(), { scene, brightness, backgroundColor: background });
  const atlas = image(await readFile(new URL(`../assets/scenes/${scene}/atlas.png`, import.meta.url)));
  expect([atlas.width, atlas.height]).toEqual([
    selected.cols * TILES_PER_ROW, selected.rows * (FRAME_COUNT / TILES_PER_ROW),
  ]);
  const paletteIndices = new Set<number>();
  for (const frame of [0, 7, 8, 63]) {
    const decoded = image(await readFile(generated.framePaths[frame]));
    expect([decoded.width, decoded.height]).toEqual([selected.cols * 6, selected.rows * selected.cell * 6]);
    const tileX = (frame % TILES_PER_ROW) * selected.cols;
    const tileY = Math.floor(frame / TILES_PER_ROW) * selected.rows;
    for (let y = 0; y < selected.rows; y++) {
      for (let x = 0; x < selected.cols; x++) {
        const packed = pixel(atlas, tileX + x, tileY + y)[0];
        const paletteIndex = packed >> 2;
        const step = packed & 3;
        paletteIndices.add(paletteIndex);
        const color = rgb(step === 0 ? selected.ground : selected.palette[paletteIndex]);
        const actual = pixel(decoded, x * 6 + 2, y * 6 + 2);
        const expected = additive(color);
        if (!actual.every((channel, index) => channel === expected[index])) {
          throw new Error(`${scene} frame ${frame}, cell ${x},${y} has the wrong native color.`);
        }
      }
    }
  }
  expect([...paletteIndices].some((index) => index >= 32)).toBe(true);
  const first = await readFile(generated.framePaths[0]);
  const last = await readFile(generated.framePaths[63]);
  expect(first.equals(last)).toBe(false);
}, 60_000);

test("rejects a damaged atlas, an unexpected size, and trailing data", async () => {
  const original = await readFile(new URL("../assets/scenes/misty-forest/atlas.png", import.meta.url));
  const damaged = Buffer.from(original);
  damaged[damaged.length - 5] ^= 1;
  await expect(decodeRgbaPng(damaged, 1600, 800)).rejects.toThrow("damaged");
  await expect(decodeRgbaPng(original, 1200, 600)).rejects.toThrow("unexpected format");
  await expect(decodeRgbaPng(Buffer.concat([original, Buffer.from([0])]), 1600, 800)).rejects.toThrow("damaged");
});
