import { expect, test } from "bun:test";
import { join } from "node:path";
import type { SurfacePeer } from "./surface-peer";

/** The script's one printed line, read from its output as it starts. */
async function readyLine(out: ReadableStream<Uint8Array>): Promise<SurfacePeer> {
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    // Only whole lines: the last piece may still be arriving.
    const line = text
      .split("\n")
      .slice(0, -1)
      .find((l) => l.startsWith("{"));
    if (line) {
      reader.releaseLock();
      return JSON.parse(line) as SurfacePeer;
    }
    if (done) throw new Error(`the peer stopped before it was ready: ${text}`);
  }
}

// A surface service's own tests run this script from another repository: this keeps it starting and answering.
test("the surface peer serves the app, the bridge and its door over HTTP", async () => {
  const peer = Bun.spawn(["bun", join(import.meta.dir, "surface-peer.ts")], { stdout: "pipe", stderr: "inherit" });
  try {
    const ready = await readyLine(peer.stdout);
    const auth = { authorization: `Bearer ${ready.token}` };
    const health = () => fetch(`${ready.bridgeUrl}/api/surface/v1/health`, { headers: auth });

    const ok = await health();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, surface: "Test chat" });
    expect((await fetch(`${ready.bridgeUrl}/api/surface/v1/health`)).status).toBe(401);

    expect(ready.people.map((p) => p.email)).toEqual([
      "owner@example.com",
      "ana@example.com",
      "theo@example.com",
      "bea@example.com",
    ]);
    const [ana] = ready.people.slice(1);
    const links = await fetch(`${ready.appUrl}/api/app/me/surface-links`, {
      headers: { cookie: ana?.cookie ?? "", origin: ready.origin },
    });
    expect(links.status).toBe(200);
    expect(await links.json()).toMatchObject({ surface: { name: "Test chat" }, allowed: true, links: [] });

    expect(Array.isArray(await (await fetch(`${ready.doorUrl}/emails`)).json())).toBe(true);
    expect(Array.isArray(await (await fetch(`${ready.doorUrl}/pushes`)).json())).toBe(true);
    const turn = (isDown: boolean) =>
      fetch(`${ready.doorUrl}/bridge`, { method: "POST", body: JSON.stringify({ down: isDown }) });
    await turn(true);
    expect((await health()).status).toBe(503);
    await turn(false);
    expect((await health()).status).toBe(200);
  } finally {
    peer.kill();
    await peer.exited;
  }
}, 180_000);
