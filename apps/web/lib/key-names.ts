/**
 * The keys a shortcut names, as the reader's keyboard prints them: in
 * their language, and with ⌘ for Ctrl on Apple's systems, where every
 * shortcut of the app takes either.
 */
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

/** Whether a platform's shortcuts are written with ⌘ rather than Ctrl. */
export function writesCommandKey(platform: string): boolean {
  return /^(mac|iphone|ipad|ipod)/i.test(platform);
}

function browserPlatform(): string {
  const hints = (
    navigator as Navigator & { userAgentData?: { platform: string } }
  ).userAgentData;
  return hints?.platform ?? navigator.platform;
}

const KEYS = {
  ctrl: msg({ message: "Ctrl", context: "keyboard key" }),
  shift: msg({ message: "Shift", context: "keyboard key" }),
  enter: msg({ message: "Enter", context: "keyboard key" }),
  escape: msg({ message: "Esc", context: "keyboard key" }),
  space: msg({ message: "Space", context: "keyboard key" }),
  delete: msg({ message: "Delete", context: "keyboard key" }),
  home: msg({ message: "Home", context: "keyboard key" }),
  end: msg({ message: "End", context: "keyboard key" }),
};

export type KeyNames = Record<Exclude<keyof typeof KEYS, "ctrl">, string> & {
  /** Ctrl, or ⌘ on Apple's systems. */
  mod: string;
};

export function useKeyNames(): KeyNames {
  const { t } = useLingui();
  return {
    mod: writesCommandKey(browserPlatform()) ? "⌘" : t(KEYS.ctrl),
    shift: t(KEYS.shift),
    enter: t(KEYS.enter),
    escape: t(KEYS.escape),
    space: t(KEYS.space),
    delete: t(KEYS.delete),
    home: t(KEYS.home),
    end: t(KEYS.end),
  };
}
