import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ForestState } from "./background.ts";
import { generateItermAssets } from "./iterm-assets.ts";
import type { GeneratedItermAssets } from "./iterm-assets.ts";
import { FRAME_COUNT, isSceneId, SAMPLE_FPS } from "./scenes.ts";
import type { SceneId } from "./scenes.ts";

export interface ItermSnapshot {
  imagePath: string;
  profileName: string;
  backgroundColor: readonly [number, number, number];
}

/** A replacement must compare the current path before mutating it, and return the observed path. */
export interface ItermBridge {
  read(sessionId: string): Promise<ItermSnapshot>;
  replace(sessionId: string, expected: string, next: string): Promise<{ outcome: "applied" | "conflict" | "rejected"; snapshot: ItermSnapshot }>;
}

type Options = {
  onError?: (error: Error) => void;
  // Native-boundary and clock injection keep lifecycle/ownership tests independent of macOS.
  sessionId?: string;
  bridge?: ItermBridge;
  generateAssets?: typeof generateItermAssets;
  schedule?: (callback: () => Promise<void>, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
  temporaryDirectory?: string;
};
const SCRIPT = fileURLToPath(new URL("../assets/iterm-background.applescript", import.meta.url));
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const OWNERSHIP_ERROR = "The iTerm2 background image was changed outside this forest controller. Animation stopped and the user's image was not overwritten. Turn the forest off before enabling it again.";


function sessionUUID(value: string | undefined): string {
  const uuid = value?.slice(value.lastIndexOf(":") + 1);
  if (!uuid || !UUID.test(uuid)) throw new Error("Forest requires a valid ITERM_SESSION_ID from the exact local iTerm2 pane. Run omp directly in iTerm2; the focused pane is never used as a fallback.");
  return uuid.toUpperCase();
}


async function invoke(sessionId: string, operation: "read" | "replace", expected?: string, next?: string): Promise<{ outcome: string; snapshot: ItermSnapshot }> {
  const args = [SCRIPT, operation, sessionId];
  if (operation === "replace") args.push(expected!, next!);
  const { promise, resolve: resolveOutput, reject } = Promise.withResolvers<string>();
  execFile("/usr/bin/osascript", args, { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) { resolveOutput(stdout); return; }
    const detail = stderr.trim() || error.message;
    if (/-1743|not authorized|not permitted/i.test(detail)) {
      reject(new Error(`iTerm2 Automation permission was denied. Allow the app running omp to control iTerm2 in System Settings → Privacy & Security → Automation, then try again. ${detail}`));
    } else if (error.killed || /-1712|timed out/i.test(detail)) {
      reject(new Error("iTerm2 background control timed out. Respond to any macOS Automation permission prompt and check that iTerm2 is responsive. The image may have changed; forest assets and ownership were retained until restoration can determine the actual image."));
    } else {
      reject(new Error(`iTerm2 background control failed: ${detail}`));
    }
  });
  const text = await promise;
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("iTerm2 returned an invalid background snapshot; no assumed state was recorded."); }
  if (!Array.isArray(data) || data.length !== 7 || typeof data[0] !== "string" || typeof data[1] !== "string" || data[1].toUpperCase() !== sessionId || typeof data[2] !== "string" || typeof data[3] !== "string" || !data.slice(4).every((v) => Number.isFinite(v) && v >= 0 && v <= 65535)) {
    throw new Error("iTerm2 returned an invalid session identity or background snapshot; no assumed state was recorded.");
  }
  return { outcome: data[0], snapshot: { imagePath: data[2], profileName: data[3], backgroundColor: [Math.round(data[4] / 257), Math.round(data[5] / 257), Math.round(data[6] / 257)] } };
}

const nativeBridge: ItermBridge = {
  async read(id) {
    const result = await invoke(id, "read");
    if (result.outcome !== "read") throw new Error("iTerm2 did not return a read snapshot.");
    return result.snapshot;
  },
  async replace(id, expected, next) {
    const result = await invoke(id, "replace", expected, next);
    if (result.outcome !== "applied" && result.outcome !== "conflict" && result.outcome !== "rejected") throw new Error("iTerm2 did not return a replacement result.");
    return { outcome: result.outcome, snapshot: result.snapshot };
  },
};

/** Controls a session property, not a profile or iTerm2's global image/blending preferences. */
export class ItermBackground {
  private name: string;
  get profileName(): string { return this.name; }
  private readonly token = randomUUID();
  private readonly bridge: ItermBridge;
  private readonly schedule: NonNullable<Options["schedule"]>;
  private readonly cancel: NonNullable<Options["cancel"]>;
  private readonly now: NonNullable<Options["now"]>;
  private pending: Promise<void> = Promise.resolve();
  private timer: unknown;
  private epoch = 0;
  private locked = false;
  private closing = false;
  private shutdown: Promise<void> | undefined;
  private original: ItermSnapshot | undefined;
  private applied: string | undefined;
  // A subprocess can time out after its setter ran. Keep both possible owned paths.
  private attempted: string | undefined;
  private fault: Error | undefined;
  private directory: string | undefined;
  private assets: GeneratedItermAssets | undefined;
  private brightness: number | undefined;
  private scene: SceneId | undefined;
  private frame = 0;
  private direction = 1;
  private variant = 0;

  private constructor(private readonly id: string, private readonly options: Options, private readonly lockPath: string) {
    this.name = id;
    this.bridge = options.bridge ?? nativeBridge;
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; });
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.now = options.now ?? Date.now;
  }

  static async create(options: Options = {}): Promise<ItermBackground> {
    if (!options.bridge && (process.platform !== "darwin" || process.env.TERM_PROGRAM !== "iTerm.app")) throw new Error("The native iTerm2 background backend requires omp running locally in iTerm2 on macOS.");
    const id = sessionUUID(options.sessionId ?? process.env.ITERM_SESSION_ID);
    const root = options.temporaryDirectory ?? tmpdir();
    const lockPath = join(root, `omp-forest-iterm-${userInfo().uid}-${id}.lock`);
    // Acquire before initialization too, so nested controllers cannot capture another forest as baseline.
    const controller = new ItermBackground(id, options, lockPath);
    await controller.acquire();
    try {
      const snapshot = await controller.bridge.read(id);
      controller.name = snapshot.profileName;
      return controller;
    } catch (error) {
      await controller.release();
      throw error;
    }
  }

  apply(state: ForestState): Promise<void> {
    if (this.closing) return Promise.reject(new Error("The iTerm2 forest controller has shut down."));
    const requested = { ...state };
    const epoch = this.stop();
    return this.enqueue(async () => {
      if (this.closing) throw new Error("The iTerm2 forest controller has shut down.");
      if (!requested.enabled) {
        const fault = this.fault;
        await this.restoreNow();
        this.fault = undefined;
        if (fault && !this.options.onError) throw fault;
        return;
      }
      if (this.fault) throw this.fault;
      if (!Number.isFinite(requested.brightness) || requested.brightness < 0 || requested.brightness > 0.3) throw new Error("Forest brightness must be a finite number between 0 and 0.3.");
      if (!isSceneId(requested.scene)) throw new Error(`Unknown forest scene: ${requested.scene}.`);
      await this.acquire();
      try {
        const current = await this.bridge.read(this.id);
        if (this.original) {
          if (current.imagePath !== this.applied) throw new Error(OWNERSHIP_ERROR);
        } else {
          this.original = current;
        }
        this.directory ??= await mkdtemp(join(this.options.temporaryDirectory ?? tmpdir(), "omp-forest-iterm-assets-"));
        if (!this.assets || this.scene !== requested.scene || this.brightness !== requested.brightness) {
          const assets = await (this.options.generateAssets ?? generateItermAssets)(join(this.directory, String(this.variant++)), { scene: requested.scene, brightness: requested.brightness, backgroundColor: this.original.backgroundColor });
          if (assets.framePaths.length !== FRAME_COUNT || assets.frameIntervalMs !== 1000 / SAMPLE_FPS || !assets.framePaths.every(isAbsolute)) throw new Error(`The iTerm2 forest assets must contain ${FRAME_COUNT} absolute image paths at ${SAMPLE_FPS}fps.`);
          this.assets = assets;
          this.scene = requested.scene;
          this.brightness = requested.brightness;
        }
        this.frame = 0;
        this.direction = 1;
        await this.change(current.imagePath, this.assets.framePaths[0]);
        if (requested.animated && epoch === this.epoch && !this.closing) this.arm(epoch, this.assets.frameIntervalMs);
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
  }

  /** Terminal shutdown. apply(enabled:false) is the reusable off operation. */
  restore(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.stop();
    this.shutdown = this.enqueue(async () => {
      const fault = this.fault;
      await this.restoreNow();
      this.fault = undefined;
      if (fault && !this.options.onError) throw fault;
    });
    return this.shutdown;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation);
    // Store a fulfilled tail, but return the rejecting operation to its caller.
    this.pending = next.catch(() => {});
    return next;
  }

  private stop(): number {
    this.epoch++;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    return this.epoch;
  }

  private arm(epoch: number, delay: number): void {
    this.timer = this.schedule(() => {
      if (this.closing || epoch !== this.epoch) return Promise.resolve();
      this.timer = undefined;
      return this.enqueue(async () => {
        if (this.closing || epoch !== this.epoch || this.fault || !this.assets || this.applied === undefined) return;
        const deadline = this.now() + this.assets.frameIntervalMs;
        if (this.frame === FRAME_COUNT - 1) this.direction = -1;
        else if (this.frame === 0) this.direction = 1;
        const next = this.frame + this.direction;
        await this.change(this.applied, this.assets.framePaths[next]);
        this.frame = next;
        if (!this.closing && epoch === this.epoch) this.arm(epoch, Math.max(0, deadline - this.now()));
      }).catch((error) => this.fail(error));
    }, delay);
  }


  private fail(error: unknown): void {
    this.stop();
    this.fault = error instanceof Error ? error : new Error(String(error));
    try { this.options.onError?.(this.fault); } catch { /* Notification failures must not become unhandled timer rejections. */ }
  }

  private async change(expected: string, next: string): Promise<void> {
    // iTerm2's setter accepts missing files without reporting a load error.
    await access(next);
    this.attempted = next;
    const result = await this.bridge.replace(this.id, expected, next);
    this.attempted = undefined;
    if (result.outcome === "conflict") throw new Error(OWNERSHIP_ERROR);
    if (result.outcome !== "applied" || result.snapshot.imagePath !== next) {
      // Preserve a possible setter result for restoration; never claim it applied.
      this.attempted = next;
      throw new Error("iTerm2 did not accept the forest image path. Animation stopped; turn the forest off to restore any still-owned image.");
    }
    this.applied = next;
  }

  private async acquire(): Promise<void> {
    if (this.locked) return;
    await mkdir(resolve(this.lockPath, ".."), { recursive: true });
    try { await mkdir(this.lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Another forest controller owns this iTerm2 pane. Disable or close it first. After a crash, restore the pane's image manually and remove the stale ownership directory: ${this.lockPath}`);
    }
    this.locked = true;
    try { await writeFile(join(this.lockPath, "owner.json"), JSON.stringify({ token: this.token, pid: process.pid, sessionId: this.id }), "utf8"); }
    catch (error) { await rm(this.lockPath, { recursive: true, force: true }); this.locked = false; throw error; }
  }

  private async release(): Promise<void> {
    if (!this.locked) return;
    const owner = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as { token: string };
    if (owner.token !== this.token) throw new Error("iTerm2 pane ownership changed unexpectedly; its ownership directory was not removed.");
    await rm(this.lockPath, { recursive: true });
    this.locked = false;
  }

  private async restoreNow(): Promise<void> {
    let current: ItermSnapshot | undefined;
    let manualChange = false;
    if (this.original) {
      current = await this.bridge.read(this.id);
      if (current.imagePath === this.applied || current.imagePath === this.attempted) {
        const result = await this.bridge.replace(this.id, current.imagePath, this.original.imagePath);
        if (result.outcome === "rejected" || (result.outcome === "applied" && result.snapshot.imagePath !== this.original.imagePath)) throw new Error("iTerm2 did not restore the original image. Ownership and generated files were retained; check the pane and try turning the forest off again.");
        current = result.snapshot; // A conflict means the user's newer replacement wins.
        manualChange = result.outcome === "conflict";
      } else {
        manualChange = true;
      }
    }
    this.original = undefined;
    this.applied = undefined;
    this.attempted = undefined;
    this.assets = undefined;
    this.brightness = undefined;
    this.scene = undefined;
    await this.release();
    if (this.directory && current) {
      const imageRelative = relative(this.directory, current.imagePath);
      const stillReferenced = current.imagePath !== "" && imageRelative !== ".." && !imageRelative.startsWith(`..${sep}`) && !isAbsolute(imageRelative);
      if (!manualChange && !stillReferenced) await rm(this.directory, { recursive: true, force: true });
      // A manual selection may reference an asset through a symlink; preserve its directory.
      this.directory = undefined;
    }
  }
}
