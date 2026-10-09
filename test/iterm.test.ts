import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ItermBackground } from "../src/iterm.ts";
import type { ItermBridge, ItermSnapshot } from "../src/iterm.ts";
import type { GeneratedItermAssets } from "../src/iterm-assets.ts";

const enabled = { enabled: true, animated: true, brightness: 0.16 };
const off = { ...enabled, enabled: false };
const directories: string[] = [];
const controllers: ItermBackground[] = [];

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  return Promise.withResolvers<void>();
}

class Clock {
  time = 0;
  next: { callback: () => Promise<void>; delay: number } | undefined;
  schedule = (callback: () => Promise<void>, delay: number) => {
    if (this.next) throw new Error("Concurrent timers are forbidden in this test clock.");
    this.next = { callback, delay };
    return this.next;
  };
  cancel = (timer: unknown) => { if (timer === this.next) this.next = undefined; };
  async tick() {
    const next = this.next;
    if (!next) throw new Error("No animation timer is scheduled.");
    this.next = undefined;
    this.time += next.delay;
    await next.callback();
  }
}

/** A stateful native-boundary model: pane identity, compare-before-write, and failure after a setter. */
class Sessions implements ItermBridge {
  readonly panes = new Map<string, ItermSnapshot>();
  activePane = randomUUID().toUpperCase();
  writes: Array<{ id: string; next: string }> = [];
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  pause: { entered: Deferred; finish: Deferred } | undefined;
  failure: { error: Error; afterWrite: boolean } | undefined;
  beforeCompare: (() => void) | undefined;

  async read(id: string) {
    this.calls++;
    const pane = this.panes.get(id);
    if (!pane) throw new Error("The exact pane does not exist.");
    return { ...pane };
  }

  async replace(id: string, expected: string, next: string) {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.pause) {
        const pause = this.pause;
        this.pause = undefined;
        pause.entered.resolve();
        await pause.finish.promise;
      }
      this.beforeCompare?.();
      this.beforeCompare = undefined;
      const pane = this.panes.get(id);
      if (!pane) throw new Error("The exact pane does not exist.");
      if (pane.imagePath !== expected) return { outcome: "conflict" as const, snapshot: { ...pane } };
      const failure = this.failure;
      this.failure = undefined;
      if (failure && !failure.afterWrite) throw failure.error;
      pane.imagePath = next;
      this.writes.push({ id, next });
      if (failure) throw failure.error;
      return { outcome: "applied" as const, snapshot: { ...pane } };
    } finally {
      this.inFlight--;
    }
  }
}

async function fixture(originalImage = "") {
  const directory = await mkdtemp(join(tmpdir(), "omp-forest-iterm-test-"));
  directories.push(directory);
  const id = randomUUID().toUpperCase();
  const sessions = new Sessions();
  sessions.panes.set(id, { imagePath: originalImage, profileName: "Target pane", backgroundColor: [12, 24, 36] });
  sessions.panes.set(sessions.activePane, { imagePath: "/focused-pane.png", profileName: "Focused pane", backgroundColor: [90, 80, 70] });
  const clock = new Clock();
  const failures: Error[] = [];
  const generations: Array<{ brightness: number; backgroundColor: readonly [number, number, number] }> = [];
  let frames: string[] = [];
  const options = {
    sessionId: `w99t7p3:${id.toLowerCase()}`,
    bridge: sessions,
    temporaryDirectory: directory,
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: () => clock.time,
    onError: (error: Error) => { failures.push(error); },
    generateAssets: async (output: string, params: { brightness: number; backgroundColor: readonly [number, number, number] }): Promise<GeneratedItermAssets> => {
      generations.push(params);
      await mkdir(output, { recursive: true });
      frames = Array.from({ length: 64 }, (_, frame) => join(output, `${frame}.png`));
      await Promise.all(frames.map((path) => writeFile(path, "image fixture")));
      return { framePaths: frames, frameIntervalMs: 500 };
    },
  };
  const controller = await ItermBackground.create(options);
  controllers.push(controller);
  return { controller, options, directory, id, sessions, clock, failures, generations, image: () => sessions.panes.get(id)!.imagePath, frames: () => frames };
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    try { await controller.restore(); } catch { /* Tests deliberately exercise retained failures. */ }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("native iTerm2 session background lifecycle", () => {
  test("targets the inherited exact UUID, never the focused pane, and ping-pongs without duplicated endpoints", async () => {
    const f = await fixture();
    await f.controller.apply(enabled);
    expect(f.controller.profileName).toBe("Target pane");
    expect(f.generations).toEqual([{ brightness: 0.16, backgroundColor: [12, 24, 36] }]);
    for (let step = 0; step < 126; step++) {
      expect(f.clock.next?.delay).toBe(500);
      await f.clock.tick();
    }
    const sequence = f.sessions.writes.map(({ next }) => f.frames().indexOf(next));
    expect(sequence).toEqual([...Array.from({ length: 64 }, (_, i) => i), ...Array.from({ length: 63 }, (_, i) => 62 - i)]);
    expect(f.sessions.writes.every(({ id }) => id === f.id)).toBe(true);
    expect(f.sessions.panes.get(f.sessions.activePane)!.imagePath).toBe("/focused-pane.png");
    await f.controller.apply({ ...enabled, animated: false });
    expect(f.image()).toBe(f.frames()[0]);
    expect(f.clock.next).toBeUndefined();
  });

  test("off drains a tick already in flight and cannot leave its image behind", async () => {
    const f = await fixture("/original.png");
    await f.controller.apply(enabled);
    const pause = { entered: deferred(), finish: deferred() };
    f.sessions.pause = pause;
    const tick = f.clock.tick();
    await pause.entered.promise;
    const disabled = f.controller.apply(off);
    expect(f.clock.next).toBeUndefined();
    pause.finish.resolve();
    await Promise.all([tick, disabled]);
    expect(f.image()).toBe("/original.png");
    expect(f.sessions.maxInFlight).toBe(1);
    expect(f.clock.next).toBeUndefined();
  });

  test("a manual image change stops animation, reports failure, and survives off", async () => {
    const f = await fixture("/original.png");
    await f.controller.apply(enabled);
    f.sessions.panes.get(f.id)!.imagePath = "/user replacement\nwith \"quotes\".png";
    await f.clock.tick();
    expect(f.failures).toHaveLength(1);
    expect(f.clock.next).toBeUndefined();
    await expect(f.controller.apply({ ...enabled, animated: false })).rejects.toThrow("changed outside");
    await f.controller.apply(off);
    expect(f.image()).toBe("/user replacement\nwith \"quotes\".png");
    await f.controller.apply({ ...enabled, animated: false });
    await f.controller.apply(off);
    expect(f.image()).toBe("/user replacement\nwith \"quotes\".png");
  });

  test("compare-before-write also preserves a change made while an update is preparing", async () => {
    const f = await fixture();
    await f.controller.apply(enabled);
    f.sessions.beforeCompare = () => { f.sessions.panes.get(f.id)!.imagePath = "/late-user-change.png"; };
    await expect(f.controller.apply({ ...enabled, brightness: 0.2 })).rejects.toThrow("changed outside");
    expect(f.image()).toBe("/late-user-change.png");
    await f.controller.apply(off);
    expect(f.image()).toBe("/late-user-change.png");
  });

  test("restores empty paths exactly and re-enable captures a fresh image and color baseline", async () => {
    const f = await fixture("");
    await f.controller.apply({ ...enabled, animated: false });
    await f.controller.apply(off);
    expect(f.image()).toBe("");
    const pane = f.sessions.panes.get(f.id)!;
    pane.imagePath = "/new baseline.png";
    pane.backgroundColor = [22, 33, 44];
    await f.controller.apply({ ...enabled, brightness: 0.2, animated: false });
    expect(f.generations[1]).toEqual({ brightness: 0.2, backgroundColor: [22, 33, 44] });
    await f.controller.restore();
    expect(f.image()).toBe("/new baseline.png");
    const calls = f.sessions.calls;
    await expect(f.controller.apply(enabled)).rejects.toThrow("shut down");
    await f.controller.restore();
    expect(f.sessions.calls).toBe(calls);
    expect(f.clock.next).toBeUndefined();
  });

  test("a timed-out setter may have applied: retain files, report, and restore the observed owned path", async () => {
    const f = await fixture("/original.png");
    await f.controller.apply(enabled);
    const error = new Error("Automation timed out after the setter");
    f.sessions.failure = { error, afterWrite: true };
    await f.clock.tick();
    expect(f.failures).toEqual([error]);
    expect(f.image()).toBe(f.frames()[1]);
    await access(f.frames()[1]);
    await expect(f.controller.apply(enabled)).rejects.toThrow("Automation timed out");
    await f.controller.apply(off);
    expect(f.image()).toBe("/original.png");
    await expect(access(f.frames()[1])).rejects.toThrow();
  });

  test("a user-selected generated frame is never removed during off or shutdown", async () => {
    const f = await fixture();
    await f.controller.apply(enabled);
    const selected = f.frames()[20];
    f.sessions.panes.get(f.id)!.imagePath = selected;
    await f.clock.tick();
    await f.controller.apply(off);
    expect(f.image()).toBe(selected);
    await access(selected);
    await f.controller.restore();
    await access(selected);
  });

  test("nested controllers cannot capture a forest baseline; off releases ownership", async () => {
    const f = await fixture();
    await f.controller.apply(enabled);
    await expect(ItermBackground.create(f.options)).rejects.toThrow("Another forest controller");
    await f.controller.apply(off);
    const second = await ItermBackground.create(f.options);
    controllers.push(second);
    await second.apply({ ...enabled, animated: false });
    await expect(f.controller.apply(enabled)).rejects.toThrow("Another forest controller");
    await second.restore();
    expect(f.image()).toBe("");
  });

  test("shutdown drains the current tick, restores, and never schedules another call", async () => {
    const f = await fixture("/original.png");
    await f.controller.apply(enabled);
    const pause = { entered: deferred(), finish: deferred() };
    f.sessions.pause = pause;
    const tick = f.clock.tick();
    await pause.entered.promise;
    const shutdown = f.controller.restore();
    await expect(f.controller.apply(enabled)).rejects.toThrow("shut down");
    pause.finish.resolve();
    await Promise.all([tick, shutdown]);
    expect(f.image()).toBe("/original.png");
    expect(f.sessions.maxInFlight).toBe(1);
    expect(f.clock.next).toBeUndefined();
    const calls = f.sessions.calls;
    await f.controller.restore();
    expect(f.sessions.calls).toBe(calls);
  });

  test("a manual replacement during restoration wins its final comparison", async () => {
    const f = await fixture("/original.png");
    await f.controller.apply({ ...enabled, animated: false });
    f.sessions.beforeCompare = () => { f.sessions.panes.get(f.id)!.imagePath = "/manual-during-off.png"; };
    await f.controller.apply(off);
    expect(f.image()).toBe("/manual-during-off.png");
    await f.controller.apply({ ...enabled, animated: false });
    await f.controller.apply(off);
    expect(f.image()).toBe("/manual-during-off.png");
  });

  test("a missing inherited UUID cannot fall back to the active pane", async () => {
    const f = await fixture();
    await f.controller.apply(off);
    f.sessions.panes.delete(f.id);
    await expect(ItermBackground.create(f.options)).rejects.toThrow("exact pane does not exist");
    expect(f.sessions.panes.get(f.sessions.activePane)!.imagePath).toBe("/focused-pane.png");
    expect(f.sessions.writes).toHaveLength(0);
  });

  test("without an error callback, the next off call reports a timer failure after restoring", async () => {
    const f = await fixture("/original.png");
    await f.controller.apply(off);
    const controller = await ItermBackground.create({ ...f.options, onError: undefined });
    controllers.push(controller);
    await controller.apply(enabled);
    f.sessions.failure = { error: new Error("Native update failed"), afterWrite: false };
    await f.clock.tick();
    expect(f.clock.next).toBeUndefined();
    await expect(controller.apply(off)).rejects.toThrow("Native update failed");
    expect(f.image()).toBe("/original.png");
    await controller.apply({ ...enabled, animated: false });
    await controller.apply(off);
    expect(f.image()).toBe("/original.png");
  });
});
