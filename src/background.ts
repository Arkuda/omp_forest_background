import { ItermBackground } from "./iterm.ts";
import { TerminalBackground } from "./terminal.ts";
import type { SceneId } from "./scenes.ts";

export interface ForestState {
  enabled: boolean;
  animated: boolean;
  brightness: number;
  scene: SceneId;
}

export interface Background {
  readonly profileName: string;
  apply(state: ForestState): Promise<void>;
  restore(): Promise<void>;
}

export interface BackgroundOptions {
  profileId?: string;
  settingsPath?: string;
  onError?: (error: Error) => void;
}

/** Use the terminal's native background, never an ANSI viewport approximation. */
export async function createBackground(options: BackgroundOptions = {}): Promise<Background> {
  if (process.platform === "darwin" && process.env.TERM_PROGRAM === "iTerm.app") {
    return ItermBackground.create({ onError: options.onError });
  }
  if (process.platform === "win32") {
    return TerminalBackground.create(options);
  }
  throw new Error("Forest requires Windows Terminal on Windows or a local iTerm2 session on macOS. No ANSI background fallback is used.");
}
