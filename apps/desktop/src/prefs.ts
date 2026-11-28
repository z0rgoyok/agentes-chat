/** Where the app's windows (and the main window's cover) keep their own preferences, in their shared localStorage. */
export const prefKey = (key: string) => `agentes.desktop.${key}`;

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(prefKey(key));
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T) {
  try {
    localStorage.setItem(prefKey(key), JSON.stringify(value));
  } catch {
    // ignore
  }
}
