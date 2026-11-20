import { ACCENT_ATTR, type AccentTokens, accentPalette, accentSky, isAccentHex, switchTheme } from "@agenteschat/ui";
import { setSkyColors } from "@agenteschat/ui/agent/engine";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { STORAGE_KEYS, storage } from "./storage";

export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (value: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const media = () =>
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readPreference(): ThemePreference {
  const saved = storage.get(STORAGE_KEYS.theme);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** Light/dark via `data-theme` on <html> (tokens.css), following the system unless the person picks one. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(() => media()?.matches ?? false);

  useEffect(() => {
    const query = media();
    if (!query) return;
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  useEffect(() => {
    switchTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback((value: ThemePreference) => {
    setPreferenceState(value);
    if (value === "system") storage.remove(STORAGE_KEYS.theme);
    else storage.set(STORAGE_KEYS.theme, value);
  }, []);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

/** The CSS custom properties a workspace's accent sets (tokens.css's agent family). */
export const ACCENT_VARS: Record<keyof AccentTokens, string> = {
  agent: "--agent",
  agent2: "--agent2",
  agentSoft: "--agent-soft",
  onAgent: "--on-agent",
};

/** The engine's `sky` and <html>'s `data-accent` for an accent, or back to the default with null. */
function paintSky(color: string | null) {
  setSkyColors(color ? accentSky(color) : null);
  const root = document.documentElement;
  if (color) root.setAttribute(ACCENT_ATTR, color);
  else root.removeAttribute(ACCENT_ATTR);
}

/**
 * Paints the workspace's accent (ADR 0193) for the current theme, on <html> so dialogs and menus portaled out of the
 * shell carry it too, and makes it the engine's `sky`, the color of every agent with none of its own and of the sky
 * art. Called by the workspace shell, and by the pages before sign-in with a registered host's accent (ADR 0194), never
 * both at once: leaving either takes the colors away, and no accent sets nothing, so the design system's own blue shows.
 */
export function useWorkspaceAccent(accent: string | null | undefined) {
  const { resolved } = useTheme();
  const color = isAccentHex(accent) ? accent.toLowerCase() : null;
  // Before the shell's children render (its effects run after theirs): faces and mentions drawn in this render
  // already take it. Idempotent; the effect below keeps it and takes it away.
  if (typeof document !== "undefined" && document.documentElement.getAttribute(ACCENT_ATTR) !== color) paintSky(color);
  useLayoutEffect(() => {
    paintSky(color);
    return () => paintSky(null);
  }, [color]);
  useLayoutEffect(() => {
    if (!color) return;
    const style = document.documentElement.style;
    const tokens = accentPalette(color)[resolved];
    for (const [key, name] of Object.entries(ACCENT_VARS)) style.setProperty(name, tokens[key as keyof AccentTokens]);
    return () => {
      for (const name of Object.values(ACCENT_VARS)) style.removeProperty(name);
    };
  }, [color, resolved]);
}
