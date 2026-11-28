import { createHash } from "node:crypto";
import { inflateZlib } from "./inflate";

export const ZERO_OID = "0".repeat(40);

/** One ref update a `git push` asks for. */
export interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * The commands at the start of a `git-receive-pack` request: pkt-lines
 * (`<old> <new> <ref>`, capabilities after a NUL on the first) up to a flush,
 * then the pack. Returns where the pack starts.
 */
export function parseReceivePackRequest(body: Uint8Array): {
  commands: RefCommand[];
  packStart: number;
  pushOptions: boolean;
  capabilities: string[];
} {
  const commands: RefCommand[] = [];
  let pos = 0;
  let pushOptions = false;
  let capabilities: string[] = [];
  const text = new TextDecoder();
  for (;;) {
    if (pos + 4 > body.length) throw new Error("truncated push request");
    const len = Number.parseInt(text.decode(body.subarray(pos, pos + 4)), 16);
    if (Number.isNaN(len)) throw new Error("bad pkt-line");
    if (len === 0) {
      pos += 4;
      break;
    }
    if (len < 4 || pos + len > body.length) throw new Error("bad pkt-line length");
    let line = text.decode(body.subarray(pos + 4, pos + len));
    pos += len;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      capabilities = line
        .slice(nul + 1)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (capabilities.includes("push-options")) pushOptions = true;
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, "");
    if (line.startsWith("shallow ") || line.startsWith("push-cert")) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (!m) throw new Error("bad push command");
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  // Push options (when negotiated) come as another pkt-line section before the pack.
  if (pushOptions) {
    for (;;) {
      if (pos + 4 > body.length) break;
      const len = Number.parseInt(text.decode(body.subarray(pos, pos + 4)), 16);
      pos += len === 0 ? 4 : len;
      if (len === 0) break;
    }
  }
  return { commands, packStart: pos, pushOptions, capabilities };
}

export interface PackCommit {
  oid: string;
  parents: string[];
}

/**
 * Object count and the commits (with their parents) in a pack. `git pack-objects` stores most pushed commits as deltas
 * of other commits in the same pack, so a delta whose base is a commit read earlier is resolved: without that, a long
 * fast-forward push stops at its first deltified commit and reads as a force push. A delta on a base outside the pack
 * (a thin pack) or on a non-commit is counted but not read.
 */
export function readPack(
  data: Uint8Array,
  start = 0,
  options: { maxObjects?: number; maxInflatedBytes?: number; maxCommitBytes?: number } = {},
) {
  if (data.length - start === 0) return { objects: 0, commits: [] as PackCommit[] };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (new TextDecoder().decode(data.subarray(start, start + 4)) !== "PACK") throw new Error("not a pack");
  const version = view.getUint32(start + 4);
  if (version !== 2 && version !== 3) throw new Error("unsupported pack version");
  const count = view.getUint32(start + 8);
  if (count > (options.maxObjects ?? 1_000_000)) throw new Error("too many objects");
  let pos = start + 12;
  let inflatedTotal = 0;
  const maxCommitBytes = options.maxCommitBytes ?? 2 * 1024 * 1024;
  const maxInflatedBytes = options.maxInflatedBytes ?? 128 * 1024 * 1024;
  const commits: PackCommit[] = [];
  /** Each commit's content, by where its object starts and by id: the bases a later delta may name. */
  const commitAt = new Map<number, Uint8Array>();
  const commitById = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (pos >= data.length) throw new Error("truncated pack object");
    const objectStart = pos;
    let c = data[pos++] as number;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      if (pos >= data.length || shift > 49) throw new Error("invalid pack object size");
      c = data[pos++] as number;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > maxInflatedBytes - inflatedTotal)
      throw new Error("pack exceeds uncompressed size limit");
    if (type === 1 && size > maxCommitBytes) throw new Error("commit exceeds size limit");
    let base: Uint8Array | undefined;
    if (type === 6) {
      // OFS_DELTA: the base starts this many bytes before this object (git's offset encoding, `get_delta_base`).
      if (pos >= data.length) throw new Error("truncated pack object");
      c = data[pos++] as number;
      let back = c & 0x7f;
      while (c & 0x80) {
        if (pos >= data.length || back > 2 ** 45) throw new Error("invalid delta offset");
        c = data[pos++] as number;
        back = (back + 1) * 128 + (c & 0x7f);
      }
      base = commitAt.get(objectStart - back);
    } else if (type === 7) {
      // REF_DELTA: the base's id.
      if (pos + 20 > data.length) throw new Error("truncated pack object");
      base = commitById.get(Buffer.from(data.subarray(pos, pos + 20)).toString("hex"));
      pos += 20;
    }
    // A delta that git writes is smaller than what it builds, so one bigger than a commit may be is never kept in memory.
    if (base && size > maxCommitBytes) throw new Error("commit exceeds size limit");
    const inflated = inflateZlib(data, pos, { keep: type === 1 || base !== undefined, maxOut: Math.max(size, 1) });
    if (inflated.size !== size) throw new Error("pack object size mismatch");
    inflatedTotal += inflated.size;
    pos = inflated.end;
    let content = type === 1 ? inflated.data : undefined;
    if (base && inflated.data) {
      content = applyDelta(base, inflated.data, maxCommitBytes);
      // A small delta can expand to a large commit: what it expands to counts against the same limit.
      if (content.length > maxInflatedBytes - inflatedTotal) throw new Error("pack exceeds uncompressed size limit");
      inflatedTotal += content.length;
    }
    if (content) {
      const header = new TextEncoder().encode(`commit ${content.length}\0`);
      const oid = createHash("sha1").update(header).update(content).digest("hex");
      commitAt.set(objectStart, content);
      commitById.set(oid, content);
      const head = new TextDecoder().decode(content.subarray(0, Math.min(content.length, 64 * 1024)));
      // Parents as git reads them (`parse_commit_buffer`): only the `parent` lines right after the `tree` line. Git
      // ignores a `parent` line anywhere else, so counting it would pass a root commit off as a fast-forward.
      const lines = head.split("\n");
      const parents: string[] = [];
      for (const line of /^tree [0-9a-f]{40}$/.test(lines[0] ?? "") ? lines.slice(1) : []) {
        const p = /^parent ([0-9a-f]{40})$/.exec(line);
        if (!p) break;
        parents.push(p[1] as string);
      }
      commits.push({ oid, parents });
    }
  }
  return { objects: count, commits };
}

/** A git delta (`patch_delta`) applied to its base; the result is refused above `max` bytes. */
function applyDelta(base: Uint8Array, delta: Uint8Array, max: number) {
  let pos = 0;
  const byte = () => {
    if (pos >= delta.length) throw new Error("bad delta");
    return delta[pos++] as number;
  };
  const varint = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 49) throw new Error("bad delta");
      const c = byte();
      n += (c & 0x7f) * 2 ** shift;
      if (!(c & 0x80)) return n;
    }
  };
  if (varint() !== base.length) throw new Error("bad delta");
  const size = varint();
  if (size > max) throw new Error("commit exceeds size limit");
  const out = new Uint8Array(size);
  let at = 0;
  while (pos < delta.length) {
    const op = byte();
    let from: Uint8Array;
    let start: number;
    let length: number;
    if (op & 0x80) {
      start = 0;
      length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) start += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) length += byte() * 2 ** (8 * i);
      if (length === 0) length = 0x10000;
      from = base;
    } else if (op) {
      from = delta;
      start = pos;
      length = op;
      pos += op;
    } else throw new Error("bad delta");
    if (start + length > from.length || at + length > size) throw new Error("bad delta");
    out.set(from.subarray(start, start + length), at);
    at += length;
  }
  if (at !== size) throw new Error("bad delta");
  return out;
}

/**
 * Whether `newOid` descends from `oldOid` using the commits of the pack.
 * `outside` lists commits the walk reached that aren't in the pack (they
 * exist upstream): the caller asks GitHub about those.
 */
export function walkToOld(commits: PackCommit[], oldOid: string, newOid: string) {
  const byId = new Map(commits.map((c) => [c.oid, c]));
  const seen = new Set<string>();
  const outside = new Set<string>();
  const queue = [newOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === oldOid) return { reached: true, outside: [] as string[] };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = byId.get(oid);
    if (!commit) {
      outside.add(oid);
      continue;
    }
    queue.push(...commit.parents);
  }
  return { reached: false, outside: [...outside] };
}

/** pkt-line encoding (for error replies). */
export const pkt = (line: string) => {
  const bytes = new TextEncoder().encode(line);
  return `${(bytes.length + 4).toString(16).padStart(4, "0")}${line}`;
};
