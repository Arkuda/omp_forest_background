import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface GeneratedAssets {
  atlasPath: string;
  shaderTemplatePath: string;
}

/** Copies the baked original-scene data and configurable native shader to a session directory. */
export async function generateAssets(outputDirectory: string): Promise<GeneratedAssets> {
  const atlasPath = join(outputDirectory, "forest-atlas.png");
  const shaderTemplatePath = join(outputDirectory, "forest.hlsl");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    copyFile(new URL("../assets/forest-atlas.png", import.meta.url), atlasPath),
    copyFile(new URL("../assets/forest.hlsl", import.meta.url), shaderTemplatePath),
  ]);
  return { atlasPath, shaderTemplatePath };
}
