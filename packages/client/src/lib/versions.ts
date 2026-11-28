/** Release versions (`1.2.3`, `v1.2.3`, `1.2.3-beta.1`), as the desktop app and the server tag them. */

export interface ParsedVersion {
  nums: number[];
  pre: string[];
}

export function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m?.[1]) return null;
  return { nums: m[1].split(".").map(Number), pre: m[2] ? m[2].split(".") : [] };
}

/** Semver order: -1, 0 or 1. Unparseable versions sort first. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  const n = Math.max(pa.nums.length, pb.nums.length, 3);
  for (let i = 0; i < n; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const isNewer = (latest: string, current: string) => compareVersions(latest, current) > 0;
