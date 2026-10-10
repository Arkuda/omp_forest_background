import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalBackground } from "../src/terminal.ts";
import type { ForestState } from "../src/background.ts";

const FIRST = "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}";
const SECOND = "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}";
const SHADER = "experimental.pixelShaderPath";
const IMAGE = "experimental.pixelShaderImagePath";
const state: ForestState = { enabled: true, animated: false, brightness: 0.08, scene: "tokyo-rain" };
const directories: string[] = [];
const controllers: TerminalBackground[] = [];
const inheritedProfile = process.env.WT_PROFILE_ID;

type Appearance = { guid: string; [key: string]: unknown };

async function fixture(): Promise<{ settingsPath: string; profileBindingPath: string; original: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-forest-binding-"));
  directories.push(directory);
  const settingsPath = join(directory, "settings.json");
  const profileBindingPath = join(directory, "agent", "forest-profile.json");
  const original = JSON.stringify({
    defaultProfile: SECOND,
    profiles: { list: [
      { guid: FIRST, name: "First", commandline: "forest-fixture-shell.exe", [IMAGE]: "C:\\first.png" },
      { guid: SECOND, name: "Second", commandline: "forest-fixture-shell.exe", [IMAGE]: "C:\\second.png" },
    ] },
  }, null, 2);
  await writeFile(settingsPath, original, "utf8");
  return { settingsPath, profileBindingPath, original };
}

async function appearances(settingsPath: string): Promise<Appearance[]> {
  const text = await readFile(settingsPath, "utf8");
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("profiles" in value) ||
    typeof value.profiles !== "object" || value.profiles === null || !("list" in value.profiles)) {
    throw new Error("Malformed fixture profiles");
  }
  const list = value.profiles.list;
  if (!Array.isArray(list) || !list.every((profile): profile is Appearance =>
    typeof profile === "object" && profile !== null && "guid" in profile && typeof profile.guid === "string")) {
    throw new Error("Malformed fixture profile list");
  }
  return list;
}

beforeEach(() => { delete process.env.WT_PROFILE_ID; });
afterEach(async () => {
  if (inheritedProfile === undefined) delete process.env.WT_PROFILE_ID;
  else process.env.WT_PROFILE_ID = inheritedProfile;
  try {
    for (const controller of controllers.splice(0)) await controller.restore();
  } finally {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  }
});

// Cold selection can perform two real CIM queries, each bounded by the controller's 10s timeout.
const DETECTION_TEST_TIMEOUT = 25_000;

describe("remembered Windows Terminal profile", () => {
  test("a successful explicit choice survives a new controller without a profile flag", async () => {
    const options = await fixture();
    const first = await TerminalBackground.create({ ...options, profileId: FIRST });
    controllers.push(first);
    await first.apply(state);
    await first.restore();
    const resumed = await TerminalBackground.create(options);
    controllers.push(resumed);
    await resumed.apply(state);
    const profiles = await appearances(options.settingsPath);
    expect(profiles[0]![SHADER]).toEndWith("tokyo-rain-b0.08-a0.hlsl");
    expect(profiles[0]![IMAGE]).toEndWith("tokyo-rain-atlas.png");
    expect(profiles[1]).toEqual(JSON.parse(options.original).profiles.list[1]);
    await resumed.restore();
    expect(await appearances(options.settingsPath)).toEqual(JSON.parse(options.original).profiles.list);
    await rm(options.profileBindingPath);
    await expect(TerminalBackground.create(options)).rejects.toThrow("Use /forest profile");
    expect(await appearances(options.settingsPath)).toEqual(JSON.parse(options.original).profiles.list);
  }, DETECTION_TEST_TIMEOUT);

  test("reliable current-tab detection wins over an old saved choice without replacing it", async () => {
    const options = await fixture();
    const first = await TerminalBackground.create({ ...options, profileId: FIRST });
    controllers.push(first);
    await first.apply(state);
    await first.restore();
    const saved = await readFile(options.profileBindingPath, "utf8");
    process.env.WT_PROFILE_ID = SECOND;
    const detected = await TerminalBackground.create(options);
    controllers.push(detected);
    await detected.apply(state);
    const profiles = await appearances(options.settingsPath);
    expect(profiles[0]).toEqual(JSON.parse(options.original).profiles.list[0]);
    expect(profiles[1]![SHADER]).toEndWith("tokyo-rain-b0.08-a0.hlsl");
    expect(await readFile(options.profileBindingPath, "utf8")).toBe(saved);
  });

  test("an explicit new choice wins over both detection and the saved choice", async () => {
    const options = await fixture();
    const first = await TerminalBackground.create({ ...options, profileId: FIRST });
    controllers.push(first);
    await first.apply(state);
    await first.restore();
    process.env.WT_PROFILE_ID = FIRST;
    const selected = await TerminalBackground.create({ ...options, profileId: SECOND });
    controllers.push(selected);
    await selected.apply(state);
    await selected.restore();
    delete process.env.WT_PROFILE_ID;
    const resumed = await TerminalBackground.create(options);
    controllers.push(resumed);
    await resumed.apply(state);
    const profiles = await appearances(options.settingsPath);
    expect(profiles[0]).toEqual(JSON.parse(options.original).profiles.list[0]);
    expect(profiles[1]![SHADER]).toEndWith("tokyo-rain-b0.08-a0.hlsl");
  }, DETECTION_TEST_TIMEOUT);

  test("a saved GUID never authorizes changes to a different settings file", async () => {
    const firstOptions = await fixture();
    const first = await TerminalBackground.create({ ...firstOptions, profileId: FIRST });
    controllers.push(first);
    await first.apply(state);
    await first.restore();
    const secondOptions = await fixture();
    await expect(TerminalBackground.create({
      settingsPath: secondOptions.settingsPath,
      profileBindingPath: firstOptions.profileBindingPath,
    })).rejects.toThrow("different Windows Terminal settings file");
    expect(await readFile(secondOptions.settingsPath, "utf8")).toBe(secondOptions.original);
    expect(await appearances(firstOptions.settingsPath)).toEqual(JSON.parse(firstOptions.original).profiles.list);
  }, DETECTION_TEST_TIMEOUT);

  test("invalid saved data is reported, while an explicit successful choice repairs it", async () => {
    const options = await fixture();
    const first = await TerminalBackground.create({ ...options, profileId: FIRST });
    controllers.push(first);
    await first.apply(state);
    await first.restore();
    await writeFile(options.profileBindingPath, '{"profileId":"wrong","settingsPath":"relative.json"}', "utf8");
    await expect(TerminalBackground.create(options)).rejects.toThrow("Saved forest profile is invalid");
    expect(await appearances(options.settingsPath)).toEqual(JSON.parse(options.original).profiles.list);
    const repaired = await TerminalBackground.create({ ...options, profileId: SECOND });
    controllers.push(repaired);
    await repaired.apply(state);
    await repaired.restore();
    const resumed = await TerminalBackground.create(options);
    controllers.push(resumed);
    await resumed.apply(state);
    expect((await appearances(options.settingsPath))[1]![SHADER]).toEndWith("tokyo-rain-b0.08-a0.hlsl");
  }, DETECTION_TEST_TIMEOUT);

  test("a failed activation does not remember a profile or alter terminal appearance", async () => {
    const options = await fixture();
    const controller = await TerminalBackground.create({ ...options, profileId: FIRST });
    controllers.push(controller);
    await expect(controller.apply({ ...state, brightness: 0.5 })).rejects.toThrow("brightness");
    await expect(readFile(options.profileBindingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(options.settingsPath, "utf8")).toBe(options.original);
  });

  test.skipIf(process.platform !== "win32")("a known current-tab GUID is never replaced when the settings channel is ambiguous", async () => {
    const options = await fixture();
    const controller = await TerminalBackground.create({ ...options, profileId: FIRST });
    controllers.push(controller);
    await controller.apply(state);
    await controller.restore();
    const saved = await readFile(options.profileBindingPath, "utf8");
    const directory = await mkdtemp(join(tmpdir(), "omp-forest-channels-"));
    directories.push(directory);
    for (const channel of ["Microsoft.WindowsTerminal_8wekyb3d8bbwe", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"]) {
      const localState = join(directory, "Packages", channel, "LocalState");
      await mkdir(localState, { recursive: true });
      await writeFile(join(localState, "settings.json"), options.original, "utf8");
    }
    const script = join(directory, "probe.ts");
    await writeFile(script, `import { TerminalBackground } from ${JSON.stringify(new URL("../src/terminal.ts", import.meta.url).href)};
try {
  const controller = await TerminalBackground.create({ profileBindingPath: ${JSON.stringify(options.profileBindingPath)} });
  await controller.apply(${JSON.stringify(state)});
  await controller.restore();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`, "utf8");
    const environment: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: directory, WT_PROFILE_ID: SECOND, WT_SESSION: "" };
    for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
    environment.PATH = "";
    const child = Bun.spawn([process.execPath, script], { cwd: directory, env: environment, stdout: "ignore", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot unambiguously locate");
    expect(await readFile(options.profileBindingPath, "utf8")).toBe(saved);
    expect(await appearances(options.settingsPath)).toEqual(JSON.parse(options.original).profiles.list);
  }, DETECTION_TEST_TIMEOUT);
});
