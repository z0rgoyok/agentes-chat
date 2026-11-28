import { expect, test } from "bun:test";
import {
  dockerUpgrade,
  fetchServerRelease,
  latestServerRelease,
  nativeUpgrade,
  runnersAhead,
  SERVER_RELEASES_API,
  SERVER_RELEASES_PAGE,
  serverUpdate,
} from "../src/lib/server-release";

const page = (tag: string) => `https://github.com/agentes-chat/agentes-chat/releases/tag/${tag}`;
const release = (tag: string, over: Record<string, unknown> = {}) => ({ tag_name: tag, html_url: page(tag), ...over });

test("the newest server release: only `v<semver>` tags, published, never the desktop app's or a helper's", () => {
  const list = [
    release("speech-helper-v0.9.0"),
    release("desktop-v0.8.20"),
    release("v0.1.18"),
    release("v0.1.20", { draft: true }),
    release("v0.1.19", { prerelease: true }),
    release("v0.1.17"),
  ];
  expect(latestServerRelease(list)).toEqual({ version: "0.1.18", url: page("v0.1.18") });
  // Out of order, by version, not by place.
  expect(latestServerRelease([release("v0.1.9"), release("v0.1.10")])?.version).toBe("0.1.10");
  // A link that isn't the repository's own: the releases page instead.
  expect(latestServerRelease([release("v1.0.0", { html_url: "https://example.com/x" })])?.url).toBe(
    SERVER_RELEASES_PAGE,
  );
  expect(latestServerRelease([release("desktop-v0.8.20")])).toBeNull();
  expect(latestServerRelease({ message: "API rate limit exceeded" })).toBeNull();
});

test("an update only when the release is newer than the server", () => {
  const latest = { version: "0.1.19", url: page("v0.1.19") };
  expect(serverUpdate("0.1.18", latest)).toBe(latest);
  expect(serverUpdate("0.1.19", latest)).toBeNull();
  // Built from main, ahead of the latest release.
  expect(serverUpdate("0.1.20", latest)).toBeNull();
  expect(serverUpdate(undefined, latest)).toBeNull();
  expect(serverUpdate("0.1.18", null)).toBeNull();
});

test("the browser asks GitHub with no referrer and no cookies, and a refusal is no release", async () => {
  const asked: { url: string; init: RequestInit }[] = [];
  const ok = await fetchServerRelease(async (url, init) => {
    asked.push({ url, init });
    return Response.json([release("v0.1.18")]);
  });
  expect(ok).toEqual({ version: "0.1.18", url: page("v0.1.18") });
  expect(asked[0]?.url).toBe(SERVER_RELEASES_API);
  expect(asked[0]?.url.startsWith("https://api.github.com/repos/agentes-chat/agentes-chat/releases")).toBe(true);
  expect(asked[0]?.init).toMatchObject({ referrerPolicy: "no-referrer", credentials: "omit" });
  expect(await fetchServerRelease(async () => new Response("{}", { status: 403 }))).toBeNull();
});

test("the upgrade commands are SELF_HOSTING.md's, for the release's version", () => {
  expect(dockerUpgrade("0.1.19")).toBe(
    [
      "curl -fsSLO https://raw.githubusercontent.com/agentes-chat/agentes-chat/v0.1.19/docker-compose.yml",
      "docker compose pull",
      "docker compose up -d",
    ].join("\n"),
  );
  expect(nativeUpgrade("0.1.19")).toBe("~/.agentes/app/0.1.19/bin/agentes-server service install --data ~/.agentes");
});

test("computers whose runner is ahead of the server", () => {
  expect(runnersAhead([{ protocol: 95 }, { protocol: 94 }, { protocol: 12 }, {}], 94)).toBe(1);
  expect(runnersAhead([], 94)).toBe(0);
});
