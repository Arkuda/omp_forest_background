import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { TerminalBackground } from "../src/terminal.ts";

const PROFILE = "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}";
const OTHER = "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}";
const SHADER = "experimental.pixelShaderPath";
const IMAGE = "experimental.pixelShaderImagePath";
const state = { enabled: true, animated: true, brightness: 0.1 };
const directories: string[] = [];
const controllers: TerminalBackground[] = [];

type Settings = { profiles: { defaults: Record<string, unknown>; list: Array<Record<string, unknown>> }; [key: string]: unknown };

async function fixture(fields = ""): Promise<{ settingsPath: string; original: string; controller: TerminalBackground }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-forest-terminal-"));
  directories.push(directory);
  const settingsPath = join(directory, "settings.json");
  const original = `{
    // global comment: leave this exactly alone
    "defaultProfile": "${OTHER}",
    "profiles": {
        "defaults": { "font": { "size": 13 }, "opacity": 87 }, // default appearance
        "list": [
            {
                // Лес: selected profile comment
                "guid": "${PROFILE}",
                "name": "Windows PowerShell",
                ${fields}
                "commandline": "%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe",
            },
            { "guid": "${OTHER}", "name": "Other", "experimental.pixelShaderPath": "C:\\\\Shaders\\\\other.hlsl" }, // unrelated shader
        ],
    },
    "theme": "dark", // global tail comment
}
`.replaceAll("\n", "\r\n");
  await writeFile(settingsPath, original, "utf8");
  const controller = await TerminalBackground.create({ settingsPath, profileId: PROFILE.toUpperCase() });
  controllers.push(controller);
  return { settingsPath, original, controller };
}

async function settings(path: string): Promise<{ text: string; value: Settings; target: Record<string, unknown> }> {
  const text = await readFile(path, "utf8");
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as Settings;
  expect(errors).toEqual([]);
  const target = value.profiles.list.find((profile) => profile.guid === PROFILE)!;
  expect(target).toBeDefined();
  return { text, value, target };
}

afterEach(async () => {
  try {
    for (const controller of controllers.splice(0)) await controller.restore();
  } finally {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  }
});

describe("profile-scoped Windows Terminal JSONC configuration", () => {
  test("preserves comments, CRLF, global defaults, and the other profile", async () => {
    const { settingsPath, original, controller } = await fixture();
    expect(controller.profileName).toBe("Windows PowerShell");
    await controller.apply(state);
    const { text, value, target } = await settings(settingsPath);
    expect(target[SHADER]).toBeString();
    expect(target[IMAGE]).toBeString();
    expect(value.defaultProfile).toBe(OTHER);
    expect(value.profiles.defaults).toEqual({ font: { size: 13 }, opacity: 87 });
    expect(value.profiles.list[1]).toEqual({ guid: OTHER, name: "Other", [SHADER]: "C:\\Shaders\\other.hlsl" });
    for (const comment of ["// global comment: leave this exactly alone", "// default appearance", "// Лес: selected profile comment", "// unrelated shader", "// global tail comment"]) expect(text).toContain(comment);
    const otherLine = original.split("\r\n").find((line) => line.includes('"name": "Other"'))!;
    expect(text).toContain(otherLine);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    await controller.restore();
    const restored = await settings(settingsPath);
    expect(Object.hasOwn(restored.target, SHADER)).toBe(false);
    expect(Object.hasOwn(restored.target, IMAGE)).toBe(false);
    expect(restored.value.profiles.defaults).toEqual(value.profiles.defaults);
    expect(restored.text).toContain(otherLine);
  });

  test("preserves comments a user adds inside and after a managed property", async () => {
    const { settingsPath, controller } = await fixture();
    await controller.apply(state);
    const current = await settings(settingsPath);
    const changed = current.text.replace(`"${SHADER}":`, `"${SHADER}" /* user explanation */:`)
      .replace(JSON.stringify(current.target[SHADER]), `${JSON.stringify(current.target[SHADER])} /* keep this too */`);
    await writeFile(settingsPath, changed, "utf8");
    await controller.restore();
    const restored = await settings(settingsPath);
    expect(Object.hasOwn(restored.target, SHADER)).toBe(false);
    expect(Object.hasOwn(restored.target, IMAGE)).toBe(false);
    expect(restored.text).toContain("/* user explanation */");
    expect(restored.text).toContain("/* keep this too */");
  });

  test("restores existing empty/null shader values and Windows image paths", async () => {
    for (const shader of ["", null]) {
      const fields = `"${SHADER}": ${JSON.stringify(shader)}, // user's shader setting\n                "${IMAGE}": "C:\\\\Users\\\\andrey\\\\Pictures\\\\Лес.png", // user's original image`;
      const { settingsPath, controller } = await fixture(fields);
      await controller.apply(state);
      await controller.apply({ ...state, enabled: false });
      const restored = await settings(settingsPath);
      expect(Object.hasOwn(restored.target, SHADER)).toBe(true);
      expect(restored.target[SHADER]).toBe(shader);
      expect(restored.target[IMAGE]).toBe("C:\\Users\\andrey\\Pictures\\Лес.png");
      expect(restored.text).toContain("// user's shader setting");
      expect(restored.text).toContain("// user's original image");
    }
  });

  test("restores original image property presence when it was null", async () => {
    const { settingsPath, controller } = await fixture(`"${IMAGE}": null, // intentional null`);
    await controller.apply(state);
    await controller.restore();
    const restored = await settings(settingsPath);
    expect(Object.hasOwn(restored.target, SHADER)).toBe(false);
    expect(Object.hasOwn(restored.target, IMAGE)).toBe(true);
    expect(restored.target[IMAGE]).toBeNull();
    expect(restored.text).toContain("// intentional null");
  });

  test("keeps a user's replacement shader and deletion of the image while restoring", async () => {
    const { settingsPath, controller } = await fixture();
    await controller.apply(state);
    const current = await settings(settingsPath);
    const changed = current.text
      .replace(JSON.stringify(current.target[SHADER]), JSON.stringify("C:\\Shaders\\user.hlsl"))
      .replace(new RegExp(`^[ \\t]*"${IMAGE.replaceAll(".", "\\.")}"[^\\r\\n]*\\r?\\n`, "m"), "")
      .replace('"theme": "dark"', '"theme": "light"');
    await writeFile(settingsPath, changed, "utf8");
    await controller.restore();
    const restored = await settings(settingsPath);
    expect(restored.target[SHADER]).toBe("C:\\Shaders\\user.hlsl");
    expect(Object.hasOwn(restored.target, IMAGE)).toBe(false);
    expect(restored.value.theme).toBe("light");
    expect(restored.text).toContain("// global tail comment");
  });

  test("restores only its unchanged shader when the user replaces the image", async () => {
    const { settingsPath, controller } = await fixture(`"${IMAGE}": "C:\\\\old.png",`);
    await controller.apply(state);
    const current = await settings(settingsPath);
    await writeFile(settingsPath, current.text.replace(JSON.stringify(current.target[IMAGE]), JSON.stringify("C:\\new.png")), "utf8");
    await controller.restore();
    const restored = await settings(settingsPath);
    expect(Object.hasOwn(restored.target, SHADER)).toBe(false);
    expect(restored.target[IMAGE]).toBe("C:\\new.png");
  });

  test("uses the GUID after a user reorders profiles and preserves their unrelated edits", async () => {
    const { settingsPath, controller } = await fixture();
    await controller.apply(state);
    const current = await settings(settingsPath);
    current.value.profiles.list.reverse();
    current.target.font = { size: 22 };
    current.value.profiles.defaults.opacity = 65;
    await writeFile(settingsPath, JSON.stringify(current.value, null, 2), "utf8");
    await controller.restore();
    const restored = await settings(settingsPath);
    expect(restored.value.profiles.list[1]?.guid).toBe(PROFILE);
    expect(restored.target.font).toEqual({ size: 22 });
    expect(restored.value.profiles.defaults.opacity).toBe(65);
    expect(Object.hasOwn(restored.target, SHADER)).toBe(false);
    expect(Object.hasOwn(restored.target, IMAGE)).toBe(false);
    expect(restored.value.profiles.list[0]?.[SHADER]).toBe("C:\\Shaders\\other.hlsl");
  });
});
