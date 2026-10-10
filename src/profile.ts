import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export interface ProfileBinding {
  settingsPath: string;
  profileId: string;
}

export async function loadProfileBinding(path: string): Promise<ProfileBinding | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = undefined; }
  if (typeof value !== "object" || value === null ||
    !("settingsPath" in value) || typeof value.settingsPath !== "string" || !isAbsolute(value.settingsPath) ||
    !("profileId" in value) || typeof value.profileId !== "string" || !value.profileId.trim()) {
    throw new Error(`Saved forest profile is invalid: ${path}. Use /forest profile to replace it or /forest profile auto to forget it.`);
  }
  return { settingsPath: value.settingsPath, profileId: value.profileId };
}

export async function saveProfileBinding(path: string, binding: ProfileBinding): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
