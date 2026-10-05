import { useSyncExternalStore } from "react";

export type ControlSize = "small" | "medium" | "large" | "extra_large";

export const CONTROL_SCALES: Record<ControlSize, number> = { small: 0.8, medium: 1, large: 1.25, extra_large: 1.5 };

interface UiSettings {
  control_size: ControlSize;
}

const KEY = "tilecraft_ui";
let settings: UiSettings = { control_size: "medium" };
const listeners = new Set<() => void>();

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  if (saved.control_size in CONTROL_SCALES) settings = { ...settings, control_size: saved.control_size };
} catch {
  // Storage unavailable: defaults apply.
}

export const ui_settings = {
  Get: () => settings,
  Update(patch: Partial<UiSettings>) {
    settings = { ...settings, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // Not persisted; still applies this session.
    }
    for (const listener of listeners) listener();
  },
  Subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};

export function UseUiSettings(): UiSettings {
  return useSyncExternalStore(ui_settings.Subscribe, ui_settings.Get);
}
