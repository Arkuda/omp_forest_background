import { mkdir, readFile, writeFile } from "node:fs/promises";
import { encodePng } from "../src/png.ts";
import { FRAME_COUNT, SAMPLE_FPS, TILES_PER_ROW, sceneIds, scenes } from "../src/scenes.ts";
import type { SceneId } from "../src/scenes.ts";
import type { Frame } from "../src/vendor/types.ts";
import alpineDawn from "../src/vendor/alpine-dawn.ts";
import auroraFjord from "../src/vendor/aurora-fjord.ts";
import deepReef from "../src/vendor/deep-reef.ts";
import desertNight from "../src/vendor/desert-night.ts";
import earthrise from "../src/vendor/earthrise.ts";
import kyotoDusk from "../src/vendor/kyoto-dusk.ts";
import lanternLake from "../src/vendor/lantern-lake.ts";
import marineDrive from "../src/vendor/marine-drive.ts";
import mistyForest from "../src/vendor/misty-forest.ts";
import nightCoast from "../src/vendor/night-coast.ts";
import oceanSunset from "../src/vendor/ocean-sunset.ts";
import stormPlains from "../src/vendor/storm-plains.ts";
import tajDawn from "../src/vendor/taj-dawn.ts";
import tokyoRain from "../src/vendor/tokyo-rain.ts";
import varanasiGhats from "../src/vendor/varanasi-ghats.ts";

// Original factories are build-only. Preserve their ordered palette lookup:
// rendering a later sample without all earlier samples can change its colors.
const factories: Record<SceneId, () => Frame> = {
  "alpine-dawn": alpineDawn,
  "aurora-fjord": auroraFjord,
  "deep-reef": deepReef,
  "desert-night": desertNight,
  earthrise,
  "kyoto-dusk": kyotoDusk,
  "lantern-lake": lanternLake,
  "marine-drive": marineDrive,
  "misty-forest": mistyForest,
  "night-coast": nightCoast,
  "ocean-sunset": oceanSunset,
  "storm-plains": stormPlains,
  "taj-dawn": tajDawn,
  "tokyo-rain": tokyoRain,
  "varanasi-ghats": varanasiGhats,
};
const DOTS = " ·•●";
const assetsDirectory = new URL("../assets/", import.meta.url);
const template = await readFile(new URL("background.template.hlsl", assetsDirectory), "utf8");

function shaderRgb(hex: string): string {
  const rgb = [1, 3, 5].map((offset) => `${Number.parseInt(hex.slice(offset, offset + 2), 16)}.0`);
  return `float3(${rgb.join(", ")}) / 255.0`;
}

for (const scene of sceneIds) {
  const meta = scenes[scene];
  if (meta.palette.length === 0 || meta.palette.length > 64 || FRAME_COUNT % TILES_PER_ROW !== 0) {
    throw new Error(`Cannot pack the ${scene} scene into byte descriptors.`);
  }
  const width = meta.cols * TILES_PER_ROW;
  const height = meta.rows * (FRAME_COUNT / TILES_PER_ROW);
  const render = factories[scene]();
  const color = new Uint8Array(meta.cols * meta.rows);
  const stride = width * 4 + 1;
  // Filter 0 on every scanline. G and B stay zero; R holds palette*4 + dot.
  const scanlines = Buffer.alloc(stride * height);
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const rows = render(frame / SAMPLE_FPS, { color }).split("\n");
    if (rows.length !== meta.rows || rows.some((row) => row.length !== meta.cols)) {
      throw new Error(`${scene} returned an unexpected grid at frame ${frame}.`);
    }
    const tileX = (frame % TILES_PER_ROW) * meta.cols;
    const tileY = Math.floor(frame / TILES_PER_ROW) * meta.rows;
    for (let y = 0; y < meta.rows; y++) {
      for (let x = 0; x < meta.cols; x++) {
        const dotStep = DOTS.indexOf(rows[y][x]);
        const paletteIndex = color[y * meta.cols + x];
        if (dotStep < 0 || paletteIndex >= meta.palette.length) {
          throw new Error(`${scene} returned an invalid descriptor at frame ${frame}, ${x},${y}.`);
        }
        const offset = (tileY + y) * stride + 1 + (tileX + x) * 4;
        scanlines[offset] = paletteIndex * 4 + dotStep;
        scanlines[offset + 3] = 255;
      }
    }
  }
  const replacements: Record<string, string> = {
    COLS: `${meta.cols}.0`,
    ROWS: `${meta.rows}.0`,
    CELL: `${meta.cell}.0`,
    ATLAS_WIDTH: `${width}.0`,
    ATLAS_HEIGHT: `${height}.0`,
    TILES_PER_ROW: `${TILES_PER_ROW}.0`,
    FRAME_COUNT: `${FRAME_COUNT}.0`,
    SAMPLE_FPS: `${SAMPLE_FPS}.0`,
    GROUND: shaderRgb(meta.ground),
    PALETTE_SIZE: String(meta.palette.length),
    PALETTE: meta.palette.map((hex) => `    ${shaderRgb(hex)}`).join(",\n"),
  };
  const shader = template.replace(/\{\{([A-Z_]+)\}\}/g, (marker, key: string) => {
    if (key === "BRIGHTNESS" || key === "ANIMATED") return marker;
    if (!(key in replacements)) throw new Error(`Unknown shader template marker ${marker}.`);
    return replacements[key];
  });
  const directory = new URL(`scenes/${scene}/`, assetsDirectory);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(new URL("atlas.png", directory), encodePng(scanlines, width, height)),
    writeFile(new URL("background.hlsl", directory), shader),
  ]);
  console.log(`Generated ${scene}: ${width}x${height} packed atlas, ${FRAME_COUNT} original frames at ${SAMPLE_FPS}fps.`);
}
