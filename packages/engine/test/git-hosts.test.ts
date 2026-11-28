import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  connectorGrantValidator,
  createApiKeyConnection,
  createGitToolSource,
  type GitProxyDeps,
  handleGitProxy,
  insertMessage,
  issueGitToken,
  machineGitGen,
  pkt,
  setAgentComputerTarget,
  setAgentRepositories,
  setAgentScopes,
  startOAuth,
  type ToolContext,
  ZERO_OID,
} from "../src";
import { createAgentRuns } from "../src/dispatch";
import {
  checkoutDirOf,
  GIT_HOSTS,
  gitToolName,
  gitVerbOf,
  parseRepoRef,
  refInList,
  repoEntry,
  repoRefAt,
  repoRefFrom,
  repoRefName,
} from "../src/git/hosts";
import { readAdvertisement } from "../src/git/hosts/plain";
import { codeCommitAuthor } from "../src/git/person-account";
import { listOrgRepositories } from "../src/git/repo-listing";
import { checkToolCall } from "../src/tools/checks";
import { type Fixture, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PUBLIC_URL = "https://agentes.test";
const TEAM_TOKEN = "glpat-team-000000000000";
const OWN_TOKEN = "glpat-own-1111111111111";

const basicOf = (login: string) => `Basic ${Buffer.from(login).toString("base64")}`;

describe("how a repository is named", () => {
  test("GitHub's keep their name; another host's carries the host first", () => {
    expect(parseRepoRef("acme/app")).toEqual({ host: "github", path: "acme/app" });
    expect(parseRepoRef("https://github.com/acme/app.git")).toEqual({ host: "github", path: "acme/app" });
    expect(parseRepoRef("gitlab:acme/web/app")).toEqual({ host: "gitlab", path: "acme/web/app" });
    expect(parseRepoRef("https://gitlab.com/acme/web/app/-/merge_requests/3")).toEqual({
      host: "gitlab",
      path: "acme/web/app",
    });
    expect(parseRepoRef("git@bitbucket.org:acme/app.git")).toEqual({ host: "bitbucket", path: "acme/app" });
    // A git server serves the path it was given, `.git` and all, even a single part.
    expect(parseRepoRef("git:team/project.git")).toEqual({ host: "git", path: "team/project.git" });
    expect(parseRepoRef("git:project")).toEqual({ host: "git", path: "project" });
    expect(repoRefName({ host: "github", path: "acme/app" })).toBe("acme/app");
    expect(repoRefName({ host: "gitlab", path: "acme/web/app" })).toBe("gitlab:acme/web/app");
  });

  test("what names none: too deep or shallow for its host, a climb out, another site", () => {
    expect(parseRepoRef("acme")).toBeNull();
    expect(parseRepoRef("acme/web/app")).toBeNull();
    expect(parseRepoRef("bitbucket:acme/web/app")).toBeNull();
    expect(parseRepoRef("gitlab:acme")).toBeNull();
    expect(parseRepoRef("gitlab:acme/../app")).toBeNull();
    expect(parseRepoRef("svn:acme/app")).toBeNull();
    expect(parseRepoRef("https://git.acme.dev/team/app")).toBeNull();
  });

  test("a server of one's own is told by its connection's address", () => {
    expect(repoRefAt("gitlab", "https://git.acme.dev", "https://git.acme.dev/team/web/app.git")).toEqual({
      host: "gitlab",
      path: "team/web/app",
    });
    expect(repoRefAt("git", "https://code.acme.dev/git", "https://code.acme.dev/git/team/app.git")).toEqual({
      host: "git",
      path: "team/app.git",
    });
    expect(repoRefAt("gitlab", "https://git.acme.dev", "https://elsewhere.dev/team/app")).toBeNull();
    expect(repoRefAt("git", "https://code.acme.dev/git", "https://code.acme.dev/other/app")).toBeNull();
  });

  test("an agent's list: a repository or everything under an account or group, each host its own", () => {
    expect(repoEntry("acme/*")).toBe("acme/*");
    expect(repoEntry("gitlab:acme/web/*")).toBe("gitlab:acme/web/*");
    expect(repoEntry("https://gitlab.com/acme/app")).toBe("gitlab:acme/app");
    // GitHub and Bitbucket have accounts only, one part.
    expect(repoEntry("acme/web/*")).toBeNull();
    expect(repoEntry("bitbucket:acme/web/*")).toBeNull();
    const list = ["acme/app", "gitlab:acme/web/*"];
    expect(refInList(list, "Acme/App")).toBe(true);
    expect(refInList(list, "gitlab:acme/web/app")).toBe(true);
    expect(refInList(list, "gitlab:acme/web/deep/app")).toBe(true);
    expect(refInList(list, "gitlab:acme/api")).toBe(false);
    // The same path on another host is another repository.
    expect(refInList(list, "gitlab:acme/app")).toBe(false);
    expect(refInList(["gitlab:acme/web/*"], "acme/web")).toBe(false);
    expect(refInList([], "bitbucket:acme/app")).toBe(true);
  });

  test("a bare owner/name is the workspace's one host when that isn't GitHub", () => {
    const c = (connector: string) => ({ connector, ownerUserId: null, serverUrl: "https://example.test" });
    expect(repoRefFrom("acme/app", [c("gitlab")])).toEqual({ host: "gitlab", path: "acme/app" });
    expect(repoRefFrom("acme/app", [c("bitbucket"), c("linear")])).toEqual({ host: "bitbucket", path: "acme/app" });
    // GitHub connected, two other hosts, or none: it stays GitHub's, as it is written.
    expect(repoRefFrom("acme/app", [c("github"), c("gitlab")])).toEqual({ host: "github", path: "acme/app" });
    expect(repoRefFrom("acme/app", [c("gitlab"), c("bitbucket")])).toEqual({ host: "github", path: "acme/app" });
    expect(repoRefFrom("acme/app", [])).toEqual({ host: "github", path: "acme/app" });
    // An address says where it is, whatever is connected.
    expect(repoRefFrom("https://github.com/acme/app", [c("gitlab")])).toEqual({ host: "github", path: "acme/app" });
    // A person's own account is not the workspace's host.
    expect(repoRefFrom("acme/app", [{ ...c("gitlab"), ownerUserId: "u1" }])).toEqual({
      host: "github",
      path: "acme/app",
    });
  });

  test("checkouts of another host never meet GitHub's", () => {
    expect(checkoutDirOf({ host: "github", path: "acme/app" })).toBe("repos/acme/app");
    expect(checkoutDirOf({ host: "gitlab", path: "acme/web/app" })).toBe("repos/_gitlab/acme/web/app");
  });

  test("the git tools are told by their exact name and scope, per host", () => {
    expect(gitToolName("github", "git_clone")).toBe("git_clone");
    expect(gitToolName("gitlab", "request_branch_push")).toBe("gitlab_request_branch_push");
    expect(gitToolName("git", "git_clone")).toBe("gitserver_git_clone");
    expect(gitVerbOf({ name: "git_clone", scope: "github:git.read" })).toBe("git_clone");
    expect(gitVerbOf({ name: "gitlab_open_pull_request", scope: "gitlab:pr.write" })).toBe("open_pull_request");
    // A connected app's tool of the same name isn't ours.
    expect(gitVerbOf({ name: "git_clone", scope: "gitlab:git.read" })).toBeNull();
    expect(gitVerbOf({ name: "gitlab_git_clone", scope: "custom:write" })).toBeNull();
  });
});

// ── A fake GitLab ────────────────────────────────────────────────────────────

function fakeGitLab(
  options: {
    branches?: Record<string, { protected?: boolean }>;
    /** `base...tip` pairs where the tip descends from the base. */
    descends?: string[];
    /** Tokens GitLab refuses for git. */
    refuses?: string[];
  } = {},
) {
  const calls: { url: string; method: string; auth: string | null; text?: string }[] = [];
  const api = "https://gitlab.com/api/v4";
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth,
      ...(typeof init?.body === "string" ? { text: init.body } : {}),
    });
    if (url === `${api}/user`) {
      if (auth === `Bearer ${TEAM_TOKEN}`) return Response.json({ id: 9, username: "acme-bot" });
      if (auth === `Bearer ${OWN_TOKEN}`) return Response.json({ id: 77, username: "ana.dev" });
      return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    }
    if (url.startsWith(`${api}/projects?`)) {
      return Response.json([
        {
          path: "app",
          path_with_namespace: "acme/web/app",
          visibility: "private",
          last_activity_at: "2026-11-20T10:00:00Z",
          namespace: { kind: "group", full_path: "acme/web" },
        },
        {
          path: "notes",
          path_with_namespace: "ana.dev/notes",
          visibility: "public",
          last_activity_at: "2026-11-01T10:00:00Z",
          namespace: { kind: "user", full_path: "ana.dev" },
        },
      ]);
    }
    const project = `${api}/projects/${encodeURIComponent("acme/web/app")}`;
    if (url === project) return Response.json({ default_branch: "main" });
    if (url.startsWith(`${project}/repository/branches/`)) {
      const name = decodeURIComponent(url.slice(`${project}/repository/branches/`.length));
      const branch = options.branches?.[name];
      if (init?.method === "DELETE") return new Response(null, { status: branch ? 204 : 404 });
      return branch
        ? Response.json({ name, protected: branch.protected === true })
        : Response.json({ message: "404 Branch Not Found" }, { status: 404 });
    }
    if (url.startsWith(`${project}/repository/merge_base?`)) {
      const refs = [...new URL(url).searchParams.values()];
      return options.descends?.includes(`${refs[0]}...${refs[1]}`)
        ? Response.json({ id: refs[0] })
        : Response.json({ id: "f".repeat(40) });
    }
    if (url === `${project}/merge_requests` && init?.method === "POST") {
      return Response.json(
        { iid: 12, web_url: "https://gitlab.com/acme/web/app/-/merge_requests/12" },
        { status: 201 },
      );
    }
    if (url.startsWith("https://gitlab.com/acme/web/app.git/")) {
      const token =
        Buffer.from((auth ?? "").replace(/^Basic /, ""), "base64")
          .toString("utf8")
          .split(":")[1] ?? "";
      if (options.refuses?.includes(token)) return new Response("denied", { status: 403 });
      if (url.includes("/info/refs")) return new Response("001e# service=git-upload-pack\n0000");
      if (url.endsWith("/git-receive-pack")) return new Response("000eunpack ok\n0000");
      return new Response("0008NAK\n");
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, gitUrl: "https://github.test", apiUrl: "https://api.github.test" };
}

describe("GitLab, as a host", () => {
  const at = (lab = fakeGitLab()) => ({ lab, at: GIT_HOSTS.gitlab.at("https://gitlab.com", lab.fetch) });

  test("the token as git and its API take it, and a server of one's own", () => {
    expect(GIT_HOSTS.gitlab.gitLogin("glpat-x")).toBe("oauth2:glpat-x");
    const own = GIT_HOSTS.gitlab.at("https://git.acme.dev/gitlab/", fetch);
    expect(own).toMatchObject({ api: "https://git.acme.dev/gitlab/api/v4", git: "https://git.acme.dev/gitlab" });
    expect(GIT_HOSTS.gitlab.remote(own, "team/web/app")).toBe("https://git.acme.dev/gitlab/team/web/app.git");
  });

  test("the account of a token, and the address its commits are authored with", async () => {
    const { at: where } = at();
    const account = await GIT_HOSTS.gitlab.account?.(where, OWN_TOKEN);
    expect(account).toEqual({ id: "77", login: "ana.dev" });
    expect(GIT_HOSTS.gitlab.commitEmail?.(where, { id: "77", login: "ana.dev" })).toBe(
      "77-ana.dev@users.noreply.gitlab.com",
    );
    expect(await GIT_HOSTS.gitlab.account?.(where, "glpat-nobody-00000")).toBeNull();
  });

  test("what guards a branch: missing, the default one, protected", async () => {
    const { at: where } = at(
      fakeGitLab({ branches: { main: { protected: true }, "ana/fix": {}, release: { protected: true } } }),
    );
    const facts = await GIT_HOSTS.gitlab.branchFacts(where, TEAM_TOKEN, "acme/web/app", [
      "main",
      "ana/fix",
      "release",
      "gone",
    ]);
    expect(facts?.defaultBranch).toBe("main");
    expect(facts?.branches.get("ana/fix")).toEqual({ exists: true, protected: false, rules: [] });
    expect(facts?.branches.get("release")).toEqual({ exists: true, protected: true, rules: [] });
    expect(facts?.branches.get("gone")).toEqual({ exists: false });
  });

  test("a fast-forward is a merge base that is the old tip", async () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const { at: where } = at(fakeGitLab({ descends: [`${a}...${b}`] }));
    expect(await GIT_HOSTS.gitlab.descends?.(where, TEAM_TOKEN, "acme/web/app", a, b)).toBe(true);
    expect(await GIT_HOSTS.gitlab.descends?.(where, TEAM_TOKEN, "acme/web/app", b, a)).toBe(false);
  });

  test("a merge request, a draft by its title", async () => {
    const { lab, at: where } = at();
    const res = await GIT_HOSTS.gitlab.openPullRequest?.(where, TEAM_TOKEN, "acme/web/app", {
      head: "agentes/dev/fix",
      base: "",
      title: "Fix the login",
      body: "Why",
      draft: true,
    });
    expect(res).toEqual({ ok: true, number: 12, url: "https://gitlab.com/acme/web/app/-/merge_requests/12" });
    const sent = JSON.parse(lab.calls.at(-1)?.text ?? "{}");
    expect(sent).toEqual({
      source_branch: "agentes/dev/fix",
      target_branch: "main",
      title: "Draft: Fix the login",
      description: "Why",
    });
  });
});

describe("Bitbucket, as a host", () => {
  const host = GIT_HOSTS.bitbucket;

  test("an access token and a person's API token go each their own way", () => {
    expect(host.gitLogin("workspace-token")).toBe("x-token-auth:workspace-token");
    expect(host.apiHeaders("workspace-token").authorization).toBe("Bearer workspace-token");
    expect(host.gitLogin("ana@acme.dev:ATATT-1")).toBe("x-bitbucket-api-token-auth:ATATT-1");
    expect(host.apiHeaders("ana@acme.dev:ATATT-1").authorization).toBe(basicOf("ana@acme.dev:ATATT-1"));
  });

  test("branch permissions guard a branch by pattern or by its place in the branching model", async () => {
    const api = "https://api.bitbucket.org/2.0/repositories/acme/app";
    const fake = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === api) return Response.json({ mainbranch: { name: "main" } });
      if (url.startsWith(`${api}/branch-restrictions`)) {
        return Response.json({
          values: [
            { kind: "push", branch_match_kind: "glob", pattern: "release/*" },
            { kind: "delete", branch_match_kind: "glob", pattern: "keep" },
            { kind: "push", branch_match_kind: "branching_model", branch_type: "development" },
            { kind: "require_approvals_to_merge", branch_match_kind: "glob", pattern: "*" },
          ],
        });
      }
      if (url === `${api}/branching-model`) return Response.json({ development: { name: "develop" } });
      if (url.startsWith(`${api}/refs/branches/`)) {
        const name = decodeURIComponent(url.slice(`${api}/refs/branches/`.length));
        return name === "gone" ? new Response("{}", { status: 404 }) : Response.json({ name });
      }
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const facts = await host.branchFacts(host.at("", fake), "t", "acme/app", [
      "release/1.2",
      "keep",
      "develop",
      "ana/fix",
      "gone",
    ]);
    expect(facts?.defaultBranch).toBe("main");
    expect(facts?.branches.get("release/1.2")).toEqual({ exists: true, protected: false, rules: ["push"] });
    expect(facts?.branches.get("keep")).toEqual({ exists: true, protected: false, rules: ["deletion"] });
    expect(facts?.branches.get("develop")).toEqual({ exists: true, protected: false, rules: ["push"] });
    // A merge check guards merging, never a push.
    expect(facts?.branches.get("ana/fix")).toEqual({ exists: true, protected: false, rules: [] });
    expect(facts?.branches.get("gone")).toEqual({ exists: false });
  });
});

describe("a git server by address", () => {
  const line = (text: string) => pkt(text);

  test("its branches and default branch come from what it advertises", async () => {
    const oid = "1".repeat(40);
    const advertised = [
      line("# service=git-upload-pack\n"),
      "0000",
      line(`${oid} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/trunk agent=git/2\n`),
      line(`${oid} refs/heads/trunk\n`),
      line(`${oid} refs/heads/ana/fix\n`),
      line(`${oid} refs/tags/v1\n`),
      "0000",
    ].join("");
    expect(readAdvertisement(new TextEncoder().encode(advertised))).toEqual({
      defaultBranch: "trunk",
      branches: new Set(["trunk", "ana/fix"]),
    });
    expect(readAdvertisement(new TextEncoder().encode("not git"))).toBeNull();
    const seen: (string | null)[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input), new Headers(init?.headers).get("authorization"));
      return new Response(advertised);
    }) as typeof globalThis.fetch;
    const host = GIT_HOSTS.git;
    const facts = await host.branchFacts(host.at("https://code.acme.dev/git/", fake), "s3cret-token", "team/app.git", [
      "ana/fix",
      "gone",
    ]);
    expect(seen).toEqual([
      "https://code.acme.dev/git/team/app.git/info/refs?service=git-upload-pack",
      basicOf("git:s3cret-token"),
    ]);
    expect(facts?.defaultBranch).toBe("trunk");
    expect(facts?.branches.get("ana/fix")).toEqual({ exists: true, protected: false, rules: [] });
    expect(facts?.branches.get("gone")).toEqual({ exists: false });
    // It has no API: nothing it can't answer with git is offered.
    expect(host.openPullRequest).toBeUndefined();
    expect(host.descends).toBeUndefined();
    expect(host.gitLogin("ana:s3cret")).toBe("ana:s3cret");
  });
});

// ── The proxy and the tools on GitLab ────────────────────────────────────────

const sha1 = (type: string, data: Uint8Array) =>
  createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

function commitObject(parents: string[], message: string) {
  const data = enc(
    [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      ...parents.map((p) => `parent ${p}`),
      "author Dev (agentes) <dev@agents.agentes.chat> 1760000000 +0000",
      "committer Dev (agentes) <dev@agents.agentes.chat> 1760000000 +0000",
      "",
      message,
      "",
    ].join("\n"),
  );
  return { type: 1, data, oid: sha1("commit", data) };
}

function packOf(objects: { type: number; data: Uint8Array }[]) {
  const header = new Uint8Array(12);
  header.set(enc("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const o of objects) {
    let size = o.data.length;
    const bytes = [(o.type << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size > 0) {
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) | 0x80;
      bytes.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(new Uint8Array(bytes), new Uint8Array(deflateSync(o.data)));
  }
  const body = Buffer.concat(parts);
  return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
}

function pushBody(commands: { old: string; new: string; ref: string }[], pack: Uint8Array) {
  const lines = commands
    .map((c, i) => pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? "\0report-status side-band-64k" : ""}\n`))
    .join("");
  return new Uint8Array(Buffer.concat([Buffer.from(`${lines}0000`), Buffer.from(pack)]));
}

async function world(lab = fakeGitLab(), scopes = ["gitlab:git.read", "gitlab:git.write", "gitlab:pr.write"]) {
  f = await setup();
  const connectors: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: PUBLIC_URL, http: lab.fetch };
  const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
    connector: "gitlab",
    apiKey: TEAM_TOKEN,
  });
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    scopes.map((scope) => ({ connectionId: connection.id, scope })),
    connectorGrantValidator,
  );
  const m = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Mac" });
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, m.machineId);
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, m.machineId));
  const deps: GitProxyDeps = { db: f.db, secret: SECRET, connectors, upstream: lab };
  const token = issueGitToken(SECRET, {
    orgId: f.org.id,
    agentId: f.agent.id,
    sandboxId: m.machineId,
    gen: machineGitGen(row?.tokenHash ?? ""),
    exp: Math.floor(Date.now() / 1000) + 3600,
    kind: "machine",
  });
  const call = (path: string, init: { method?: string; body?: Uint8Array; query?: string } = {}) =>
    handleGitProxy(
      deps,
      new Request(`${PUBLIC_URL}/api/git/${f.org.id}/${connection.id}/${path}${init.query ?? ""}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: basicOf(`agentes:${token}`),
          ...(init.body ? { "content-type": "application/x-git-receive-pack-request" } : {}),
        },
        body: init.body,
      }),
      { orgId: f.org.id, connectionId: connection.id, path },
    );
  const push = (ref: string, old = ZERO_OID) => {
    const tip = commitObject(old === ZERO_OID ? [] : [old], "work");
    return call("acme/web/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old, new: tip.oid, ref }], packOf([tip])),
    });
  };
  return { connection, connectors, lab, call, push };
}

const gitCalls = (lab: ReturnType<typeof fakeGitLab>) => lab.calls.filter((c) => c.url.includes("app.git/"));

describe("signing in to a git host", () => {
  test("GitLab asks for its two scopes with PKCE; Bitbucket's consumer carries its own, and takes neither", async () => {
    f = await setup();
    const deps: ConnectorDeps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: PUBLIC_URL,
      oauthApps: {
        gitlab: { clientId: "gl-client", clientSecret: "gl-secret" },
        bitbucket: { clientId: "bb-client", clientSecret: "bb-secret" },
      },
    };
    const gitlab = new URL((await startOAuth(deps, f.owner.id, f.org.id, "gitlab")).authorizeUrl);
    expect(gitlab.origin + gitlab.pathname).toBe("https://gitlab.com/oauth/authorize");
    expect(gitlab.searchParams.get("client_id")).toBe("gl-client");
    expect(gitlab.searchParams.get("scope")).toBe("api write_repository");
    expect(gitlab.searchParams.get("code_challenge_method")).toBe("S256");
    const bitbucket = new URL(
      (await startOAuth(deps, f.owner.id, f.org.id, "bitbucket", { personal: true })).authorizeUrl,
    );
    expect(bitbucket.origin + bitbucket.pathname).toBe("https://bitbucket.org/site/oauth2/authorize");
    expect(bitbucket.searchParams.get("client_id")).toBe("bb-client");
    expect(bitbucket.searchParams.has("scope")).toBe(false);
    expect(bitbucket.searchParams.has("code_challenge")).toBe(false);
    // Without an application of this server's, a token still connects them; a git server only ever takes one.
    await expect(startOAuth({ ...deps, oauthApps: {} }, f.owner.id, f.org.id, "gitlab")).rejects.toThrow(
      "not configured",
    );
    await expect(startOAuth(deps, f.owner.id, f.org.id, "git")).rejects.toThrow("not configured");
  });
});

describe("the git proxy on another host", () => {
  test("connecting asks GitLab whose token it is", async () => {
    const w = await world();
    expect(w.connection).toMatchObject({ connector: "gitlab", accountLabel: "acme-bot", accountId: "9" });
    await expect(
      createApiKeyConnection(w.connectors, f.owner.id, f.org.id, { connector: "gitlab", apiKey: "glpat-nobody-00000" }),
    ).rejects.toMatchObject({ code: "connector.key_refused" });
  });

  test("a fetch goes to GitLab at the repository's own path, with the team's token", async () => {
    const w = await world();
    const res = await w.call("acme/web/app.git/info/refs", { query: "?service=git-upload-pack" });
    expect(res.status).toBe(200);
    expect(gitCalls(w.lab).at(-1)).toMatchObject({
      url: "https://gitlab.com/acme/web/app.git/info/refs?service=git-upload-pack",
      auth: basicOf(`oauth2:${TEAM_TOKEN}`),
    });
  });

  test("the agent's own branch goes; another one is refused with this host's tool named", async () => {
    const w = await world(fakeGitLab({ branches: { main: { protected: true } } }));
    expect(await (await w.push("refs/heads/agentes/dev/fix")).text()).toContain("unpack ok");
    expect(gitCalls(w.lab).filter((c) => c.method === "POST")).toHaveLength(1);
    const refused = await (await w.push("refs/heads/main", "c".repeat(40))).text();
    expect(refused).toContain("ng refs/heads/main not your branch (ask with gitlab_request_branch_push)");
    expect(refused).toContain("open a merge request");
    expect(gitCalls(w.lab).filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("the agent's repositories count per host: GitHub's names open nothing on GitLab", async () => {
    const w = await world();
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    expect((await w.call("acme/web/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(403);
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app", "gitlab:acme/web/*"]);
    expect((await w.call("acme/web/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(200);
  });

  test("without the scope on that connection, nothing is read", async () => {
    const w = await world(fakeGitLab(), []);
    const res = await w.call("acme/web/app.git/info/refs", { query: "?service=git-upload-pack" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("gitlab:git.read");
  });

  /** A code session of the agent on the GitLab project, with a run a person is behind working in it now. */
  async function session(branch: string) {
    const [channel] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "code", kind: "code", visibility: "private" })
      .returning();
    if (!channel) throw new Error("no channel");
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: channel.id,
      author: { type: "person", userId: f.owner.id },
      body: "Fix the login",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, ask as never, [f.agent.id], "mention"));
    if (!run) throw new Error("no run");
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    await f.db.insert(schema.codeSessions).values({
      orgId: f.org.id,
      channelId: channel.id,
      rootMessageId: ask.id,
      agentId: f.agent.id,
      repo: "gitlab:acme/web/app",
      repoDir: "repos/_gitlab/acme/web/app",
      title: "Fix the login",
      branch,
      createdBy: f.owner.id,
    });
    return run;
  }

  test("a session's branch is pushed as the person who asked, by the account they connected as their own", async () => {
    const w = await world();
    const own = await createApiKeyConnection(w.connectors, f.owner.id, f.org.id, {
      connector: "gitlab",
      apiKey: OWN_TOKEN,
      personal: true,
    });
    expect(own).toMatchObject({ ownerUserId: f.owner.id, accountLabel: "ana.dev", accountId: "77" });
    const run = await session("agentes/dev/fix-login");
    expect(await (await w.push("refs/heads/agentes/dev/fix-login")).text()).toContain("unpack ok");
    expect(gitCalls(w.lab).at(-1)?.auth).toBe(basicOf(`oauth2:${OWN_TOKEN}`));
    // Its commits are authored as them, at GitLab's address for the account, never their email.
    expect(await codeCommitAuthor(f.db, f.org.id, run.id)).toEqual({
      name: f.owner.name,
      email: "77-ana.dev@users.noreply.gitlab.com",
    });
    // Another branch of the agent's is no session's: the workspace's token.
    await w.push("refs/heads/agentes/dev/other");
    expect(gitCalls(w.lab).at(-1)?.auth).toBe(basicOf(`oauth2:${TEAM_TOKEN}`));
  });

  test("GitLab refusing the person's token sends the push as the workspace", async () => {
    const w = await world(fakeGitLab({ refuses: [OWN_TOKEN] }));
    await createApiKeyConnection(w.connectors, f.owner.id, f.org.id, {
      connector: "gitlab",
      apiKey: OWN_TOKEN,
      personal: true,
    });
    await session("agentes/dev/fix-login");
    expect(await (await w.push("refs/heads/agentes/dev/fix-login")).text()).toContain("unpack ok");
    expect(
      gitCalls(w.lab)
        .slice(-2)
        .map((c) => c.auth),
    ).toEqual([basicOf(`oauth2:${OWN_TOKEN}`), basicOf(`oauth2:${TEAM_TOKEN}`)]);
  });

  test("the tools carry the host's name, and a merge request opens as the person in their session", async () => {
    const w = await world();
    await createApiKeyConnection(w.connectors, f.owner.id, f.org.id, {
      connector: "gitlab",
      apiKey: OWN_TOKEN,
      personal: true,
    });
    const run = await session("agentes/dev/fix-login");
    const source = createGitToolSource({
      sandbox: { db: f.db } as never,
      connectors: w.connectors,
      github: { apiUrl: w.lab.apiUrl, fetch: w.lab.fetch },
    });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: run.channelId,
    } as ToolContext;
    const tools = await source.tools(ctx);
    expect(tools.map((t) => t.name)).toEqual([
      "list_repositories",
      "wait_for_code",
      "gitlab_git_clone",
      "gitlab_open_pull_request",
      "gitlab_delete_branches",
      "gitlab_request_branch_push",
    ]);
    expect(new Set(tools.slice(2).map((t) => t.connectionId))).toEqual(new Set([w.connection.id]));
    const open = tools.find((t) => t.name === "gitlab_open_pull_request");
    const out = await open?.execute(
      { repo: "acme/web/app", branch: "agentes/dev/fix-login", title: "Fix the login" },
      ctx,
    );
    expect(out?.content).toBe("Opened MR !12: https://gitlab.com/acme/web/app/-/merge_requests/12");
    expect(w.lab.calls.find((c) => c.url.endsWith("/merge_requests"))?.auth).toBe(`Bearer ${OWN_TOKEN}`);
    const [kept] = await f.db.select().from(schema.codeSessions);
    expect(kept).toMatchObject({ prNumber: 12, prUrl: "https://gitlab.com/acme/web/app/-/merge_requests/12" });
  });

  test("a tool call on another host is held to the agent's repositories there", async () => {
    await world();
    const check = (repo: string) =>
      checkToolCall({ scope: "gitlab:pr.write" }, { repo }, {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
      } as ToolContext);
    expect((await check("acme/web/app")).ok).toBe(true);
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/web", "gitlab:acme/web/*"]);
    expect(await check("acme/web/app")).toMatchObject({ ok: true, data: { repo: "gitlab:acme/web/app" } });
    expect(await check("gitlab:acme/web/app")).toMatchObject({ ok: true });
    expect(await check("acme/api")).toMatchObject({ ok: false, data: { deniedRepo: "gitlab:acme/api" } });
    // GitHub's `acme/web` in the list opens nothing here, and a call that names none is refused.
    expect((await check("acme/web")).ok).toBe(false);
    expect((await check("")).ok).toBe(false);
  });

  test("an agent lists the repositories it can work in, cut to its own", async () => {
    const w = await world();
    const source = createGitToolSource({
      sandbox: { db: f.db } as never,
      connectors: w.connectors,
      github: { apiUrl: w.lab.apiUrl, fetch: w.lab.fetch },
    });
    const ctx = { db: f.db, orgId: f.org.id, agentId: f.agent.id, runId: "", channelId: "" } as ToolContext;
    const list = (await source.tools(ctx)).find((t) => t.name === "list_repositories");
    expect((await list?.execute({}, ctx))?.content).toBe(
      "gitlab:acme/web/app (GitLab, private, active 2026-11-20)\ngitlab:ana.dev/notes (GitLab, public, active 2026-11-01)",
    );
    expect((await list?.execute({ query: "NOTES" }, ctx))?.data).toEqual({ repositories: ["gitlab:ana.dev/notes"] });
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["gitlab:acme/*"]);
    expect((await list?.execute({}, ctx))?.content).toBe("gitlab:acme/web/app (GitLab, private, active 2026-11-20)");
    // One tool for every host, with no connection of its own; an agent with no git access there gets nothing.
    expect(list).toMatchObject({ scope: "" });
    expect(list?.connectionId).toBeUndefined();
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [], connectorGrantValidator);
    expect((await list?.execute({}, ctx))?.content).toContain("no git access");
  });

  test("the repositories people pick from: other hosts' apart from GitHub's, by group", async () => {
    const w = await world();
    const listing = await listOrgRepositories(
      { db: f.db, connectors: w.connectors, app: null, github: { apiUrl: w.lab.apiUrl, fetch: w.lab.fetch } },
      f.owner.id,
      f.org.id,
    );
    expect(listing.accounts).toEqual([]);
    expect(listing.elsewhere.map((a) => [a.host, a.prefix, a.type, a.repositories.map((r) => r.fullName)])).toEqual([
      ["gitlab", "gitlab:acme/web", "Organization", ["gitlab:acme/web/app"]],
      ["gitlab", "gitlab:ana.dev", "User", ["gitlab:ana.dev/notes"]],
    ]);
  });
});
