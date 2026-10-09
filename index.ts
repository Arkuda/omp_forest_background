import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createBackground } from "./src/background.ts";
import type { Background, ForestState } from "./src/background.ts";

export default function forestPlugin(pi: ExtensionAPI): void {
  pi.setLabel("Misty forest — animated terminal background");
  pi.registerFlag("forest-profile", {
    type: "string",
    description: "Windows Terminal profile GUID (normally detected automatically)",
  });
  pi.registerFlag("forest-settings", {
    type: "string",
    description: "Explicit Windows Terminal settings.json path",
  });

  let state: ForestState = { enabled: true, animated: true, brightness: 0.16 };
  let background: Background | undefined;
  let loading: Promise<Background> | undefined;
  let closing = false;

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
    if (!interactive(ctx)) return;
    try {
      const terminal = await getBackground(ctx);
      if (!closing) await terminal.apply(state);
    } catch (error) {
      ctx.ui.notify(`Forest: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };

  pi.on("session_start", (_event, ctx) => activate(ctx));
  pi.on("session_switch", (_event, ctx) => activate(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!interactive(ctx)) return;
    closing = true;
    if (loading) {
      // Failed initialization is reported by activate; no terminal state was acquired.
      try { background = await loading; } catch { return; }
    }
    await background?.restore();
  });

  pi.registerCommand("forest", {
    description: "Animated terminal forest: toggle, on, off, still, animate, brightness 1–30 (%)",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) {
        ctx.ui.notify("Forest requires an interactive omp session in Windows Terminal or iTerm2.", "warning");
        return;
      }
      const value = args.trim().toLowerCase();
      const next = { ...state };
      if (!value) next.enabled = !next.enabled;
      else if (value === "on" || value === "off") next.enabled = value === "on";
      else if (value === "still" || value === "animate") {
        next.enabled = true;
        next.animated = value === "animate";
      } else if (/^brightness\s+(?:[1-9]|[12]\d|30)$/.test(value)) {
        next.brightness = Number(value.split(/\s+/)[1]) / 100;
      } else {
        ctx.ui.notify("Usage: /forest [on|off|still|animate|brightness 1–30]", "warning");
        return;
      }
      try {
        const terminal = await getBackground(ctx);
        if (closing) return;
        await terminal.apply(next);
        state = next;
        ctx.ui.notify(state.enabled
          ? `Forest: ${Math.round(state.brightness * 100)}%, ${state.animated ? "animated" : "still"}; ${terminal.profileName}`
          : "Forest: off; original terminal appearance restored", "info");
      } catch (error) {
        ctx.ui.notify(`Forest: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
