import { type BranchFact, basic, type GitHost } from "./types";

/** What a ref advertisement may weigh: a repository with more branches than this fits is answered as unknown. */
const ADVERTISEMENT_BYTES = 8 * 1024 * 1024;

/**
 * What a repository says about itself when git asks for its refs (`info/refs`): its branches, and the branch `HEAD`
 * points to (`symref=HEAD:refs/heads/main`, among the capabilities of the first line). Null when it couldn't be read.
 */
export function readAdvertisement(bytes: Uint8Array): { defaultBranch: string | null; branches: Set<string> } | null {
  const text = new TextDecoder().decode(bytes);
  const branches = new Set<string>();
  let defaultBranch: string | null = null;
  let seen = false;
  for (let i = 0; i + 4 <= text.length; ) {
    const size = Number.parseInt(text.slice(i, i + 4), 16);
    if (!Number.isFinite(size)) return null;
    if (size < 4) {
      i += 4;
      continue;
    }
    const line = text.slice(i + 4, i + size).replace(/\n$/, "");
    i += size;
    if (line.startsWith("# service=")) continue;
    const [ref = "", capabilities = ""] = line.split("\0");
    const name = ref.slice(ref.indexOf(" ") + 1);
    if (!/^[0-9a-f]{40,64} /.test(ref)) return null;
    seen = true;
    const head = /(?:^| )symref=HEAD:refs\/heads\/(\S+)/.exec(capabilities);
    if (head) defaultBranch = head[1] as string;
    if (name.startsWith("refs/heads/")) branches.add(name.slice("refs/heads/".length));
  }
  return seen ? { defaultBranch, branches } : null;
}

/**
 * A git server by its address (ADR 0227): Gitea, Forgejo, a company's own, anything that speaks git over HTTPS. It
 * has no API we know, so it answers with git itself: its branches and default branch come from what it advertises,
 * a push must carry the history that makes it a fast-forward, and a pull request is opened from the link the server
 * prints after a push. What is protected there, the server refuses by itself.
 */
export const plainHost: GitHost = {
  id: "git",
  label: "Git",
  request: "pull request",
  at(serverUrl, http) {
    const url = new URL(serverUrl);
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return { fetch: http, api: base, git: base, site: url.hostname };
  },
  remote: (at, path) => `${at.git}/${path}`,
  // A token alone goes as the password, which every server we know takes; `user:token` goes as typed.
  gitLogin: (token) => (token.includes(":") ? token : `git:${token}`),
  apiHeaders: () => ({}),
  async branchFacts(at, token, path, names) {
    const res = await at
      .fetch(`${plainHost.remote(at, path)}/info/refs?service=git-upload-pack`, {
        headers: { authorization: basic(plainHost.gitLogin(token)), "user-agent": "git/agentes-proxy" },
        redirect: "manual",
      })
      .catch(() => null);
    if (!res?.ok || Number(res.headers.get("content-length") ?? "0") > ADVERTISEMENT_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (bytes.byteLength > ADVERTISEMENT_BYTES) return null;
    const said = readAdvertisement(bytes);
    if (!said?.defaultBranch) return null;
    const branches = new Map<string, BranchFact>();
    for (const name of names) {
      branches.set(name, said.branches.has(name) ? { exists: true, protected: false, rules: [] } : { exists: false });
    }
    return { defaultBranch: said.defaultBranch, branches };
  },
};
