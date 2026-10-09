import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createBackground } from "./src/background.ts";
import type { Background, ForestState } from "./src/background.ts";
import { DEFAULT_SCENE, isSceneId, sceneIds, scenes } from "./src/scenes.ts";

export default function forestPlugin(pi: ExtensionAPI): void {
  pi.setLabel("ascii.rest scenes — animated terminal background");
  pi.registerFlag("forest-profile", {
    type: "string",
    description: "Windows Terminal profile GUID (normally detected automatically)",
  });
  pi.registerFlag("forest-settings", {
    type: "string",
    description: "Explicit Windows Terminal settings.json path",
  });
  pi.registerFlag("forest-scene", {
    type: "string",
    default: DEFAULT_SCENE,
    description: "ascii.rest scene ID (see /forest scenes)",
  });

  let state: ForestState = { enabled: true, animated: true, brightness: 0.16, scene: DEFAULT_SCENE };
  let background: Background | undefined;
  let loading: Promise<Background> | undefined;
  let closing = false;
  let initialized = false;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };

  const interactive = (ctx: ExtensionContext): boolean =>
    ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main";

  const getBackground = async (ctx: ExtensionContext): Promise<Background> => {
    if (closing) throw new Error("Forest background is shutting down");
    if (background) return background;
    if (!loading) {
      const profile = pi.getFlag("forest-profile");
      const settings = pi.getFlag("forest-settings");
      loading = createBackground({
        profileId: typeof profile === "string" ? profile : undefined,
        settingsPath: typeof settings === "string" ? settings : undefined,
        onError: (error) => {
          if (!closing) ctx.ui.notify(`Forest: animation stopped: ${error.message}`, "warning");
        },
      });
    }
    try {
      background = await loading;
      return background;
    } finally {
      loading = undefined;
    }
  };

  const activate = async (ctx: ExtensionContext): Promise<void> => {
    if (!interactive(ctx) || closing) return;
    try {
      if (!initialized) {
        const selected = pi.getFlag("forest-scene");
        if (typeof selected === "string") {
          if (!isSceneId(selected)) throw new Error(`Unknown scene "${selected}". Use /forest scenes to list supported IDs.`);
          state.scene = selected;
        }
        initialized = true;
      }
      const terminal = await getBackground(ctx);
      if (!closing) await terminal.apply(state);
    } catch (error) {
      ctx.ui.notify(`Forest: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };

  pi.on("session_start", (_event, ctx) => enqueue(() => activate(ctx)));
  pi.on("session_switch", (_event, ctx) => enqueue(() => activate(ctx)));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!interactive(ctx)) return;
    closing = true;
    await enqueue(async () => {
      await background?.restore();
    });
  });

  pi.registerCommand("forest", {
    description: "Terminal scenes: scenes, scene <id>, on, off, still, animate, brightness 1–30 (%)",
    getArgumentCompletions: (prefix) => {
      const value = prefix.toLowerCase();
      if (value.startsWith("scene ")) {
        const fragment = value.slice(6);
        return sceneIds.filter((id) => id.startsWith(fragment))
          .map((id) => ({ value: `scene ${id}`, label: id, description: scenes[id].note }));
      }
      return ["scenes", "scene", "on", "off", "still", "animate", "brightness"]
        .filter((command) => command.startsWith(value))
        .map((command) => ({ value: command, label: command }));
    },
    handler: (args, ctx) => enqueue(async () => {
      if (closing) return;
      if (!interactive(ctx)) {
        ctx.ui.notify("Forest requires an interactive omp session in Windows Terminal or iTerm2.", "warning");
        return;
      }
      const value = args.trim().toLowerCase();
      if (value === "scenes") {
        ctx.ui.notify(sceneIds.map((id) => `${id === state.scene ? "* " : "  "}${id} — ${scenes[id].note}`).join("\n"), "info");
        return;
      }
      const next = { ...state };
      if (!value) next.enabled = !next.enabled;
      else if (value === "on" || value === "off") next.enabled = value === "on";
      else if (value === "still" || value === "animate") {
        next.enabled = true;
        next.animated = value === "animate";
      } else if (/^brightness\s+(?:[1-9]|[12]\d|30)$/.test(value)) {
        next.brightness = Number(value.split(/\s+/)[1]) / 100;
      } else if (value.startsWith("scene ")) {
        const selected = value.slice(6).trim();
        if (!isSceneId(selected)) {
          ctx.ui.notify(`Unknown scene "${selected}". Use /forest scenes to list supported IDs.`, "warning");
          return;
        }
        next.scene = selected;
        next.enabled = true;
        initialized = true;
      } else {
        ctx.ui.notify("Usage: /forest [scenes|scene <id>|on|off|still|animate|brightness 1–30]", "warning");
        return;
      }
      try {
        const terminal = await getBackground(ctx);
        if (closing) return;
        await terminal.apply(next);
        state = next;
        ctx.ui.notify(state.enabled
          ? `Forest: ${state.scene}, ${Math.round(state.brightness * 100)}%, ${state.animated ? "animated" : "still"}; ${terminal.profileName}`
          : "Forest: off; original terminal appearance restored", "info");
      } catch (error) {
        ctx.ui.notify(`Forest: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }),
  });
}
