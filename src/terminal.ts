import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { createScanner, findNodeAtLocation, getNodeValue, parseTree, SyntaxKind } from "jsonc-parser";
import type { Node, ParseError } from "jsonc-parser";
import { generateAssets } from "./assets.ts";
import type { GeneratedAssets } from "./assets.ts";
import type { ForestState } from "./background.ts";
import { isSceneId } from "./scenes.ts";
import type { SceneId } from "./scenes.ts";

const SHADER = "experimental.pixelShaderPath";
const IMAGE = "experimental.pixelShaderImagePath";
const FIELDS = [SHADER, IMAGE] as const;
type Field = (typeof FIELDS)[number];
type Property = { present: boolean; value: unknown };
type Snapshot = Record<Field, Property>;
type Ancestor = { Name?: string; ExecutablePath?: string; CommandLine?: string };
type Document = { profile: Node; defaults: Node | undefined };

function property(node: Node | undefined, name: Field): Property {
  const value = node && findNodeAtLocation(node, [name]);
  return value ? { present: true, value: getNodeValue(value) } : { present: false, value: undefined };
}

function equal(left: Property, right: Property): boolean {
  return left.present === right.present && JSON.stringify(left.value) === JSON.stringify(right.value);
}

function document(text: string, profileId: string): Document {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length) throw new Error("Windows Terminal settings are not valid JSONC; fix them before enabling the forest.");
  const list = findNodeAtLocation(tree, ["profiles", "list"]);
  if (list?.type !== "array") throw new Error("Windows Terminal settings must contain profiles.list; no global defaults will be changed.");
  const matches = (list.children ?? []).filter((profile) => {
    const id = findNodeAtLocation(profile, ["guid"]);
    return id?.type === "string" && getNodeValue(id).replace(/^\{|\}$/g, "").toLowerCase() === profileId.replace(/^\{|\}$/g, "").toLowerCase();
  });
  if (matches.length !== 1) throw new Error(`Profile ${profileId} must occur exactly once in profiles.list. Open Windows Terminal Settings to find its GUID and pass profileId explicitly.`);
  const profile = matches[0]!;
  for (const field of FIELDS) {
    if ((profile.children ?? []).filter((child) => child.children?.[0]?.value === field).length > 1) {
      throw new Error(`Profile ${profileId} contains duplicate ${field} properties; resolve them before enabling the forest.`);
    }
  }
  return { profile, defaults: findNodeAtLocation(tree, ["profiles", "defaults"]) };
}

function snapshot(doc: Document): Snapshot {
  return { [SHADER]: property(doc.profile, SHADER), [IMAGE]: property(doc.profile, IMAGE) };
}

function checkCustomShader(doc: Document): void {
  const own = property(doc.profile, SHADER);
  const effective = own.present ? own.value : property(doc.defaults, SHADER).value;
  if (effective !== undefined && effective !== null && effective !== "") {
    throw new Error("This Windows Terminal profile already has a custom pixel shader (possibly inherited from profiles.defaults). Remove or disable that shader yourself before enabling the forest; it will not be overwritten.");
  }
}

function commaBetween(text: string, start: number, end: number): number | undefined {
  const scanner = createScanner(text, false);
  scanner.setPosition(start);
  for (let token = scanner.scan(); scanner.getTokenOffset() < end && token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.CommaToken) return scanner.getTokenOffset();
  }
  return undefined;
}

// Change only value/property/comma tokens. Comments and unrelated bytes stay intact,
// including comments attached to a field which is removed during restoration.
function setProperty(text: string, profileId: string, field: Field, next: Property): string {
  const { profile } = document(text, profileId);
  const children = profile.children ?? [];
  const index = children.findIndex((child) => child.children?.[0]?.value === field);
  const existing = children[index];
  if (existing) {
    const value = existing.children![1]!;
    if (next.present) return text.slice(0, value.offset) + JSON.stringify(next.value) + text.slice(value.offset + value.length);
    const before = index > 0 ? children[index - 1]! : undefined;
    const after = children[index + 1];
    const precedingComma = before && commaBetween(text, before.offset + before.length, existing.offset);
    const followingComma = commaBetween(text, existing.offset + existing.length, after?.offset ?? profile.offset + profile.length - 1);
    const comma = precedingComma ?? followingComma;
    const scanner = createScanner(text, false);
    scanner.setPosition(existing.offset);
    const edits: Array<{ offset: number; length: number }> = comma === undefined ? [] : [{ offset: comma, length: 1 }];
    for (let token = scanner.scan(); scanner.getTokenOffset() < existing.offset + existing.length && token !== SyntaxKind.EOF; token = scanner.scan()) {
      if (token !== SyntaxKind.LineCommentTrivia && token !== SyntaxKind.BlockCommentTrivia && token !== SyntaxKind.Trivia && token !== SyntaxKind.LineBreakTrivia) {
        edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength() });
      }
    }
    for (const edit of edits.sort((a, b) => b.offset - a.offset)) text = text.slice(0, edit.offset) + text.slice(edit.offset + edit.length);
    return text;
  }
  if (!next.present) return text;
  const end = profile.offset + profile.length - 1;
  const last = children.at(-1);
  const trailingComma = last && commaBetween(text, last.offset + last.length, end);
  const lineStart = text.lastIndexOf("\n", profile.offset) + 1;
  const parentIndent = text.slice(lineStart, profile.offset).match(/^[\t ]*/)?.[0] ?? "";
  const sample = children[0];
  const sampleLine = sample ? text.slice(text.lastIndexOf("\n", sample.offset) + 1, sample.offset) : "";
  const indent = /^[\t ]+$/.test(sampleLine) ? sampleLine : parentIndent + "    ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  text = text.slice(0, end) + `${eol}${indent}${JSON.stringify(field)}: ${JSON.stringify(next.value)}${eol}${parentIndent}` + text.slice(end);
  if (last && trailingComma === undefined) {
    const offset = last.offset + last.length;
    text = text.slice(0, offset) + "," + text.slice(offset);
  }
  return text;
}

async function ancestors(): Promise<Ancestor[]> {
  if (process.platform !== "win32") return [];
  const script = `$id = ${process.pid}; $seen = @{}; $items = @(); while ($id -and -not $seen.ContainsKey([int]$id)) { $seen[[int]$id] = $true; $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if (-not $p) { break }; $items += $p | Select-Object Name,ExecutablePath,CommandLine; $id = $p.ParentProcessId }; ConvertTo-Json -InputObject @($items) -Compress`;
  try {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.replace(/^\uFEFF/, "")) as Ancestor[];
  } catch {
    // Missing CIM permission cannot justify guessing a terminal channel or profile.
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function settingsPath(chain: Ancestor[]): Promise<string> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw new Error("Windows Terminal settings cannot be detected here. Pass settingsPath and profileId explicitly on Windows.");
  }
  const local = process.env.LOCALAPPDATA;
  const stable = join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json");
  const preview = join(local, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json");
  const unpackaged = join(local, "Microsoft", "Windows Terminal", "settings.json");
  const host = chain.find((item) => item.Name?.toLowerCase() === "windowsterminal.exe");
  const executable = host?.ExecutablePath;
  if (executable) {
    let candidate: string;
    if (/Microsoft\.WindowsTerminalPreview_/i.test(executable)) candidate = preview;
    else if (/Microsoft\.WindowsTerminal_/i.test(executable)) candidate = stable;
    else {
      // Portable builds keep their settings next to the executable when .portable exists.
      const directory = win32.dirname(executable);
      candidate = await exists(join(directory, ".portable")) ? join(directory, "settings", "settings.json") : unpackaged;
    }
    if (await exists(candidate)) return candidate;
    throw new Error(`The detected Windows Terminal settings file does not exist: ${candidate}. Pass settingsPath explicitly.`);
  }
  const candidates: string[] = [];
  for (const candidate of [stable, preview, unpackaged]) if (await exists(candidate)) candidates.push(candidate);
  if (candidates.length === 1) return candidates[0]!;
  throw new Error(`Cannot unambiguously locate the active Windows Terminal settings. Pass settingsPath explicitly.${candidates.length ? ` Candidates: ${candidates.join(", ")}` : " No stable, preview, or unpackaged settings file was found."}`);
}

function detectedProfile(text: string, chain: Ancestor[]): string {
  if (process.env.WT_PROFILE_ID) return process.env.WT_PROFILE_ID;
  // A shell match is evidence only inside a proven WT session. Explorer-launched
  // shells using WT as default console host otherwise have indistinguishable ancestry.
  if (process.env.WT_SESSION || chain.some((item) => item.Name?.toLowerCase() === "windowsterminal.exe")) {
    const tree = parseTree(text, [], { allowTrailingComma: true });
    const list = tree && findNodeAtLocation(tree, ["profiles", "list"]);
    const terminalIndex = chain.findIndex((item) => item.Name?.toLowerCase() === "windowsterminal.exe");
    let shell: Ancestor | undefined;
    for (let index = (terminalIndex < 0 ? chain.length : terminalIndex) - 1; index >= 0; index--) {
      if (/^(powershell|pwsh|cmd|wsl)\.exe$/i.test(chain[index]?.Name ?? "")) {
        shell = chain[index];
        break;
      }
    }
    if (shell?.ExecutablePath && list?.type === "array") {
      const normalize = (path: string) => win32.normalize(path.replace(/%([^%]+)%/g, (whole, name: string) => {
        const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
        return key ? process.env[key]! : whole;
      })).toLowerCase();
      const matches = (list.children ?? []).filter((profile) => {
        const command = findNodeAtLocation(profile, ["commandline"]);
        if (command?.type !== "string") return false;
        const executable = /^(?:"([^"]+)"|(\S+))/.exec(getNodeValue(command).trim());
        return executable && normalize(executable[1] ?? executable[2]!) === normalize(shell.ExecutablePath!);
      });
      if (matches.length === 1) {
        const id = findNodeAtLocation(matches[0]!, ["guid"]);
        if (id?.type === "string") return getNodeValue(id);
      }
    }
  }
  throw new Error("WT_PROFILE_ID is missing and the active Windows Terminal profile cannot be proven from process ancestry. Pass profileId explicitly (the profile GUID in Windows Terminal Settings), or launch omp directly in a Windows Terminal tab that supplies WT_PROFILE_ID. defaultProfile is not evidence of the active tab.");
}

/** Profile-scoped ownership: one controller may manage a given profile at a time. */
export class TerminalBackground {
  readonly profileName: string;
  private readonly token = randomUUID();
  private original: Snapshot | undefined;
  private applied: Snapshot | undefined;
  private readonly assets = new Map<SceneId, GeneratedAssets>();
  private locked = false;
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private readonly profileId: string, name: string, private readonly lockPath: string) {
    this.profileName = name;
  }

  static async create(options: { settingsPath?: string; profileId?: string } = {}): Promise<TerminalBackground> {
    const chain = options.settingsPath && (options.profileId || process.env.WT_PROFILE_ID) ? [] : await ancestors();
    const path = await realpath(resolve(options.settingsPath ?? await settingsPath(chain)));
    const text = await readFile(path, "utf8");
    const profileId = options.profileId ?? detectedProfile(text, chain);
    const doc = document(text, profileId);
    const name = findNodeAtLocation(doc.profile, ["name"]);
    const key = createHash("sha256").update(`${process.platform === "win32" ? path.toLowerCase() : path}\0${profileId.replace(/^\{|\}$/g, "").toLowerCase()}`).digest("hex").slice(0, 24);
    const controller = new TerminalBackground(path, profileId, name?.type === "string" ? getNodeValue(name) : profileId, join(dirname(path), "omp-forest-assets", `${key}.lock`));
    await controller.acquire();
    try { checkCustomShader(doc); } catch (error) {
      await controller.release();
      throw error;
    }
    return controller;
  }

  apply(state: ForestState): Promise<void> {
    const requested = { ...state };
    return this.enqueue(async () => {
      if (!requested.enabled) { await this.restoreNow(); return; }
      if (!isSceneId(requested.scene)) throw new Error(`Unknown scene: ${requested.scene}`);
      if (!Number.isFinite(requested.brightness) || requested.brightness < 0 || requested.brightness > 0.3) {
        throw new Error("Forest brightness must be a finite number between 0 and 0.3.");
      }
      await this.acquire();
      const text = await readFile(this.path, "utf8");
      const doc = document(text, this.profileId);
      const current = snapshot(doc);
      if (this.applied) {
        for (const field of FIELDS) if (!equal(current[field], this.applied[field])) {
          throw new Error(`Windows Terminal ${field} was changed outside this controller. Forest settings were not overwritten; turn the forest off before enabling it again.`);
        }
      } else {
        checkCustomShader(doc);
        this.original = current;
      }
      const directory = join(dirname(this.lockPath), this.token);
      let assets = this.assets.get(requested.scene);
      if (!assets) {
        assets = await generateAssets(directory, requested.scene);
        this.assets.set(requested.scene, assets);
      }
      const template = await readFile(assets.shaderTemplatePath, "utf8");
      if (!template.includes("{{BRIGHTNESS}}") || !template.includes("{{ANIMATED}}")) throw new Error("The forest shader template is missing its brightness/animation substitutions.");
      const brightness = Number.isInteger(requested.brightness) ? `${requested.brightness}.0` : String(requested.brightness);
      const shader = template.replaceAll("{{BRIGHTNESS}}", brightness).replaceAll("{{ANIMATED}}", requested.animated ? "1" : "0");
      // WT recompiles a changed shader path; scene and controls identify each variant.
      const shaderPath = resolve(directory, `${requested.scene}-b${brightness}-a${requested.animated ? 1 : 0}.hlsl`);
      await writeFile(shaderPath, shader, "utf8");
      const next: Snapshot = { [SHADER]: { present: true, value: shaderPath }, [IMAGE]: { present: true, value: resolve(assets.atlasPath) } };
      let changed = text;
      for (const field of FIELDS) changed = setProperty(changed, this.profileId, field, next[field]);
      await this.commit(text, changed);
      this.applied = next;
    });
  }

  restore(): Promise<void> {
    return this.enqueue(() => this.restoreNow());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation, operation);
    this.pending = next;
    return next;
  }

  private async acquire(): Promise<void> {
    if (this.locked) return;
    await mkdir(dirname(this.lockPath), { recursive: true });
    try { await mkdir(this.lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Another forest controller owns this Windows Terminal profile. Close or disable that session first. If it crashed, restore any forest shader paths in Settings and remove the stale ownership directory manually: ${this.lockPath}`);
    }
    this.locked = true;
    try {
      await writeFile(join(this.lockPath, "owner.json"), JSON.stringify({ token: this.token, pid: process.pid, profileId: this.profileId, settingsPath: this.path }), "utf8");
    } catch (error) {
      await rm(this.lockPath, { recursive: true, force: true });
      this.locked = false;
      throw error;
    }
  }

  private async release(): Promise<void> {
    if (!this.locked) return;
    const owner = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as { token: string };
    if (owner.token !== this.token) throw new Error("Forest profile ownership changed unexpectedly; its ownership directory was not removed.");
    await rm(this.lockPath, { recursive: true });
    this.locked = false;
  }

  private async commit(previous: string, next: string): Promise<void> {
    if (previous === next) return;
    // Serialize cooperating writers to different profiles in the same file too.
    const writeLock = join(dirname(this.lockPath), "settings-write.lock");
    try { await mkdir(writeLock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Windows Terminal settings are being changed by another forest controller. Try again after it finishes; if it crashed, inspect ${writeLock}.`);
    }
    try {
      if (await readFile(this.path, "utf8") !== previous) throw new Error("Windows Terminal settings changed while the forest was preparing its update. No settings were written; try again.");
      await writeFile(this.path, next, "utf8");
    } finally {
      await rm(writeLock, { recursive: true });
    }
  }

  private async restoreNow(): Promise<void> {
    if (this.applied && this.original) {
      const text = await readFile(this.path, "utf8");
      const current = snapshot(document(text, this.profileId));
      let changed = text;
      for (const field of FIELDS) {
        // A user's replacement or deletion wins; restore only values we still own.
        if (equal(current[field], this.applied[field])) changed = setProperty(changed, this.profileId, field, this.original[field]);
      }
      await this.commit(text, changed);
      this.applied = undefined;
      this.original = undefined;
    }
    await this.release();
  }
}
