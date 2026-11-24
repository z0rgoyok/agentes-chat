import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { cliVersionAtLeast } from "@agenteschat/providers/plans";
import { RunnerError } from "./errors";
import { isExecutable, ownCommand, setAgyPick } from "./executors";

/**
 * The Antigravity CLI the runner brings (ADR 0143). Which Gemini models the CLI lists and runs is its own catalog's,
 * and the runner keeps it from updating itself during turns, so a computer's `agy` would stay at the version its
 * person installed. Like the Cloud image's pin, this names one version and each system's build with Google's SHA-512
 * of it, read from the manifests its installer reads (`…/manifests/<platform>.json`, 2026-11-21). It is a floor: an
 * `agy` of the person's at this version or newer runs as it is. Outside system mode only (there the computer's setup
 * installs the CLI for the agents' users), on macOS and Linux.
 */
export const AGY_PIN = {
  version: "1.5.14",
  builds: {
    darwin_arm64: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-arm/cli_mac_arm64.tar.gz",
      sha512:
        "26830fd46bfb9200d073cf3e71bf94b707552557b4380ec01afd6e99f3a2b030e65422dab1867f77318078692defc859a7547d17ec4b0b1e9369f13c9c3caea6",
    },
    darwin_amd64: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-x64/cli_mac_x64.tar.gz",
      sha512:
        "1b6a1fc6dbe46ba6d9d0405d1b6095189f35ebfc4c3c33ceb1fd1b6d0c9fd702b52ac10b64b8b52aed0d8d71ae02c5df3cffd5e3e3d37549c2daffcce2a853c7",
    },
    linux_amd64: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64/cli_linux_x64.tar.gz",
      sha512:
        "83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9",
    },
    linux_arm64: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-arm/cli_linux_arm64.tar.gz",
      sha512:
        "c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463",
    },
    linux_amd64_musl: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-x64-musl/cli_linux_x64_musl.tar.gz",
      sha512:
        "1da24922727c5b4e84369d0843575d7d6f180a1946e2dc4289171ad1e3ca92594e687724d1902a7d83e407f98f0a8d3b7c3e976f03680fd80dbed2d2da00c0ed",
    },
    linux_arm64_musl: {
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/linux-arm-musl/cli_linux_arm64_musl.tar.gz",
      sha512:
        "f6e35fc3dab2cd49fd4296ddee0841b9cc4c7020b6c6aaea6452c5b3452b0ad8d66451c9098e418ad6b2f6eabcc81cdf13105ed043903248b11d6fb24ae709ab",
    },
  },
} as const;

export type AgyPin = { version: string; builds: Partial<Record<string, { url: string; sha512: string }>> };

/** Google's name for this system's build (`darwin_arm64`, `linux_amd64_musl`…), as its installer picks it; null: none. */
export function agyPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (file: string) => boolean = existsSync,
): string | null {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!cpu || (platform !== "darwin" && platform !== "linux")) return null;
  if (platform === "darwin") return `darwin_${cpu}`;
  const musl = exists("/lib/libc.musl-x86_64.so.1") || exists("/lib/libc.musl-aarch64.so.1");
  return `linux_${cpu}${musl ? "_musl" : ""}`;
}

/** A download, its unpacking and their checks take at most this long (a slow line, ~100 MB). */
const AGY_DOWNLOAD_MS = 15 * 60_000;
/** After a failed download, the next try waits this long. */
const AGY_RETRY_MS = 30 * 60_000;

export interface AgyCopyOptions {
  /** The runner's home: the copy goes in `bin/agy-<version>/`. */
  home: string;
  log: (line: string) => void;
  /** Whether Gemini thinks here: an account of it on this computer (the person's own `agy` counts by itself). */
  inUse: () => boolean;
  /** A new `agy` runs now: the CLIs and the accounts' models are looked at again. */
  onChange: () => void;
  /** Tests. */
  pin?: AgyPin;
  platform?: string | null;
  fetch?: typeof fetch;
  /** The person's own `agy` and its `--version` line; null: none. */
  own?: () => Promise<{ file: string; version: string } | null>;
  now?: () => number;
}

/** `file --version`'s first line, or null when it doesn't answer. */
function versionOf(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    // As every `agy` the runner starts: it never updates itself under a look.
    const env = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
    execFile(file, ["--version"], { timeout: 8000, encoding: "utf8", env }, (err, stdout) =>
      resolve(err ? null : (stdout.trim().split("\n")[0] ?? null)),
    );
  });
}

/**
 * Keeps the runner's `agy` (`AGY_PIN`): where the person's is missing or older and Gemini thinks here, it downloads
 * the pinned build, checks it against Google's SHA-512, unpacks it next to the runner and has `resolveCommand` run it
 * (`setAgyPick`). Every look (`check`) is cheap until a download is due; one runs at a time and never throws.
 */
export class AgyCopy {
  private readonly pin: AgyPin;
  private running: Promise<void> | null = null;
  private fetching: Promise<void> | null = null;
  private failedAt = 0;
  private picked: string | undefined;

  constructor(private readonly opts: AgyCopyOptions) {
    this.pin = opts.pin ?? AGY_PIN;
  }

  /** Where the pinned build's `antigravity` goes. */
  file(): string {
    return path.join(this.opts.home, "bin", `agy-${this.pin.version}`, "antigravity");
  }

  check(): Promise<void> {
    this.running ??= this.look()
      .catch((err: unknown) => this.opts.log(`agy: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async look() {
    const own = await (this.opts.own ?? ownAgy)();
    if (own && cliVersionAtLeast(own.version, this.pin.version) !== false) return this.use(undefined);
    const file = this.file();
    if (isExecutable(file)) return this.use(file);
    if (!own && !this.opts.inUse()) return;
    const now = (this.opts.now ?? Date.now)();
    if (this.failedAt && now - this.failedAt < AGY_RETRY_MS) return;
    try {
      await this.fetch(file);
      this.failedAt = 0;
    } catch (err) {
      this.failedAt = now;
      throw err;
    }
    await this.use(file);
  }

  /**
   * The runner's `agy` now, for a Gemini sign-in on a computer with none new enough: downloaded at once if due (no
   * waiting out an earlier failure). Throws, in words for the person, when it can't be brought.
   */
  async ensure(): Promise<void> {
    const own = await (this.opts.own ?? ownAgy)();
    if (own && cliVersionAtLeast(own.version, this.pin.version) !== false) return;
    const file = this.file();
    if (!isExecutable(file)) {
      try {
        await this.fetch(file);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new RunnerError("internal", `Couldn't get the Antigravity CLI ready on this computer: ${why}`);
      }
    }
    await this.use(file);
  }

  /** One download at a time, whoever asks. */
  private fetch(file: string): Promise<void> {
    this.fetching ??= this.download(file).finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async use(file: string | undefined) {
    if (this.picked === file) return;
    this.picked = file;
    setAgyPick(file);
    this.opts.log(file ? `agy: running the runner's own ${this.pin.version}` : "agy: running the computer's own");
    this.opts.onChange();
    if (file) await this.prune(path.dirname(file));
  }

  /** Other versions the runner brought before: a turn that started one keeps its open file. */
  private async prune(keep: string) {
    const bin = path.dirname(keep);
    for (const name of await readdir(bin).catch(() => [] as string[])) {
      if (name.startsWith("agy-") && path.join(bin, name) !== keep) {
        await rm(path.join(bin, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /** The pinned build for this system, refused unless its SHA-512 is Google's; unpacked aside, then moved in place. */
  private async download(file: string) {
    const platform = this.opts.platform === undefined ? agyPlatform() : this.opts.platform;
    const build = platform ? this.pin.builds[platform] : undefined;
    if (!build) throw new Error(`no Antigravity CLI build for ${process.platform} ${process.arch}`);
    const dir = path.dirname(file);
    const staging = `${dir}.${process.pid}.tmp`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      this.opts.log(`agy: downloading ${this.pin.version} (${platform})`);
      const res = await (this.opts.fetch ?? fetch)(build.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(AGY_DOWNLOAD_MS),
      });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const tarball = path.join(staging, "agy.tar.gz");
      const hash = createHash("sha512");
      const out = createWriteStream(tarball, { mode: 0o600 });
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((done) => out.once("drain", done));
      }
      await new Promise<void>((done, fail) => out.end((err?: Error | null) => (err ? fail(err) : done())));
      if (hash.digest("hex") !== build.sha512) throw new Error("the download didn't match Google's checksum");
      await new Promise<void>((done, fail) =>
        execFile("tar", ["-xzf", tarball, "-C", staging], { timeout: AGY_DOWNLOAD_MS }, (err) =>
          err ? fail(new Error(`couldn't unpack it: ${err.message}`)) : done(),
        ),
      );
      await rm(tarball, { force: true });
      const binary = path.join(staging, "antigravity");
      if (!existsSync(binary)) throw new Error("the download has no antigravity binary");
      await chmod(binary, 0o755);
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** The person's own `agy` on the PATH, never the runner's, with its version line. */
async function ownAgy(): Promise<{ file: string; version: string } | null> {
  const file = ownCommand("agy");
  const version = file ? await versionOf(file) : null;
  return file && version ? { file, version } : null;
}
