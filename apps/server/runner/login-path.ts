import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path, { win32 } from "node:path";
import { consoleText } from "./console-text";
import { envValue } from "./executors";

/**
 * An app opened from Finder (or by launchd at login) gets macOS's bare PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so `claude`, `codex`, `node`, `bun` and
 * the person's build tools aren't found, neither when we detect them nor when
 * a task runs them. In app mode the runner takes the PATH the person's login
 * shell builds (`$SHELL -ilc`), plus the usual install folders, before
 * anything else starts.
 */
const MARK = "__AGENTES_PATH__";

/** Common install folders, in the order a shell would usually have them. */
export function usualDirs(home = os.homedir()): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
}

/** The PATH printed by the login shell, or null (no shell, timeout, nothing between the marks). */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh"): string | null {
  try {
    const r = spawnSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out = `${r.stdout ?? ""}`;
    const start = out.indexOf(MARK);
    const end = out.indexOf(MARK, start + MARK.length);
    if (start < 0 || end < 0) return null;
    const value = out.slice(start + MARK.length, end).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Joins PATH lists, first wins, dropping empty and repeated entries. */
export function mergePath(...lists: (string | null | undefined)[]): string {
  return mergePathWith(path.delimiter, ...lists);
}

/** `mergePath` with its delimiter given (Windows' `;` wherever this runs); Windows' folders compare without case. */
export function mergePathWith(delimiter: string, ...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of (list ?? "").split(delimiter)) {
      const key = delimiter === ";" ? dir.toLowerCase().replace(/[\\/]+$/, "") : dir;
      if (!dir || seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}

/**
 * Where the usual installers put a CLI on Windows: Claude Code's own, npm's global launchers, Bun's, Google's for the
 * Antigravity CLI (`%LOCALAPPDATA%\agy\bin\agy.exe`, its `install.ps1`) and xAI's for Grok Build
 * (`%USERPROFILE%\.grok\bin\grok.exe`, its `install.ps1`).
 */
export function usualWindowsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = envValue(env, "USERPROFILE", "win32") || os.homedir();
  const appData = envValue(env, "APPDATA", "win32") || win32.join(home, "AppData", "Roaming");
  const localAppData = envValue(env, "LOCALAPPDATA", "win32") || win32.join(home, "AppData", "Local");
  return [
    win32.join(home, ".local", "bin"),
    win32.join(appData, "npm"),
    win32.join(home, ".bun", "bin"),
    win32.join(localAppData, "agy", "bin"),
    win32.join(home, ".grok", "bin"),
  ];
}

/**
 * `reg query`'s answer for one `Path` value: its data, `%NAME%` expanded from `env` (a `REG_EXPAND_SZ` keeps them),
 * or null when it has none.
 */
export function registryPathValue(output: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const data = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)?.[1]?.trim();
  if (!data) return null;
  return data.replace(/%([^%;]+)%/g, (all, name: string) => envValue(env, name, "win32") ?? all);
}

/**
 * The user's and the machine's `Path` as Windows keeps them now (`HKCU\Environment`, then the machine's): an app
 * keeps the PATH it started with, so a folder an installer added since is in the registry only. `reg.exe` by its full
 * path, as a bare name is looked for in the current folder first.
 */
export function windowsRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const reg = win32.join(envValue(env, "SystemRoot", "win32") || "C:\\Windows", "System32", "reg.exe");
  const read = (key: string) => {
    try {
      const r = spawnSync(reg, ["query", key, "/v", "Path"], {
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // In the console's code page: a folder with an accent read as UTF-8 was a folder that isn't there.
      return registryPathValue(consoleText(r.stdout ?? ""), env);
    } catch {
      return null;
    }
  };
  return mergePathWith(
    ";",
    read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    read("HKCU\\Environment"),
  );
}

/**
 * Windows: what we had first (so nothing that ran keeps running something else), then the registry's `Path` and the
 * usual folders that exist. Each look for the coding CLIs runs it again, not only the start.
 */
export function adoptWindowsPath(
  env: NodeJS.ProcessEnv = process.env,
  registry: () => string = () => windowsRegistryPath(env),
  exists: (dir: string) => boolean = existsSync,
): void {
  const usual = usualWindowsDirs(env).filter((d) => exists(d));
  env.PATH = mergePathWith(";", envValue(env, "PATH", "win32"), registry(), usual.join(";"));
}

/**
 * The usual folders that exist, after what `env.PATH` has: a service keeps the PATH of the shell that installed it,
 * which may lack `~/.local/bin` (or it was made since), where Google's, xAI's, Cursor's and Claude's installers put
 * their CLIs. Never in system mode: root's own folders are no agent's.
 */
export function addUsualDirs(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  exists: (dir: string) => boolean = existsSync,
): void {
  env.PATH = mergePath(env.PATH, usualDirs(home).filter(exists).join(path.delimiter));
}

/** Sets `process.env.PATH` to the login shell's PATH + the usual folders that exist + what we had. */
export function adoptLoginPath(log: (line: string) => void = () => {}): void {
  if (process.platform === "win32") {
    adoptWindowsPath();
    return;
  }
  const shell = loginShellPath();
  const usual = usualDirs()
    .filter((d) => existsSync(d))
    .join(path.delimiter);
  process.env.PATH = mergePath(shell, usual, process.env.PATH);
  log(shell ? "PATH taken from the login shell" : "PATH: the login shell gave nothing; using the usual folders");
}
