import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SceneId } from "./scenes.ts";

export interface GeneratedAssets {
  atlasPath: string;
  shaderTemplatePath: string;
}

/** Copies one baked scene and its configurable native shader to a session directory. */
export async function generateAssets(outputDirectory: string, scene: SceneId): Promise<GeneratedAssets> {
  const atlasPath = join(outputDirectory, `${scene}-atlas.png`);
  const shaderTemplatePath = join(outputDirectory, `${scene}-background.hlsl`);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    copyFile(new URL(`../assets/scenes/${scene}/atlas.png`, import.meta.url), atlasPath),
    copyFile(new URL(`../assets/scenes/${scene}/background.hlsl`, import.meta.url), shaderTemplatePath),
  ]);
  return { atlasPath, shaderTemplatePath };
}
