/**
 * A whole server with the chat surface bridge on, for a surface service's end-to-end test (ADR 0187): run it with
 * `bun apps/server/test/surface-peer.ts`. In-memory database, the fake model (the right hand answers
 * "Got it: <the person's last line>"), a fake speech service, and four accounts, each with a workspace of its own
 * whose right hand has an AI. It prints one JSON line (`SurfacePeer` below), then serves until killed, running due
 * jobs every 200 ms. Not a test file: it imports only test helpers.
 *
 * The door (127.0.0.1 only, this script only) is what a test reads and turns that no real server offers:
 * `GET /emails` and `GET /pushes` (what the fakes recorded), and `POST /bridge { "down": true | false }`, which makes
 * the bridge answer 503 until turned back.
 */
import { setSurface, surfaceFromConfig } from "@agenteschat/engine";
import { type ModelRequest, textOf } from "@agenteschat/providers";
import { createLogger } from "../src/logger";
import { operatorFetch } from "../src/operator/app";
import { browser, createTestServer, listen, signUp } from "./harness";

/** The line the script prints once it serves. The app's routes want `cookie` and `origin` on each request. */
export interface SurfacePeer {
  appUrl: string;
  bridgeUrl: string;
  doorUrl: string;
  token: string;
  origin: string;
  people: { email: string; cookie: string; orgId: string }[];
}

// Low entropy on purpose: a test value, never a real deployment's.
const token = process.env.PEER_BRIDGE_TOKEN ?? "surface-peer-test-token-".padEnd(48, "0");
const PEOPLE = ["owner", "ana", "theo", "bea"];

/** The person's last line in the model's view of the conversation. */
const lastLine = (request: ModelRequest) => {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  const text = last ? textOf(last.content).trim() : "";
  // A message that came through a surface ends with core's own note on a line of its own, "(sent by … through …)":
  // the person's words are the line before it.
  const lines = text.split("\n").filter((line) => !/^\(.*\)$/.test(line.trim()));
  // Without the "[name]: " the conversation puts before each person's line.
  return (lines.at(-1) ?? "").replace(/^\[[^\]]*\]:\s*/, "").trim();
};

const t = await createTestServer({
  env: {
    ALLOW_SIGNUP: "true",
    SURFACE_BRIDGE_TOKEN: token,
    SURFACE_NAME: "Test chat",
    SURFACE_OPEN_URL: "https://chat.example.com/open?text={text}",
    GROQ_API_KEY: "groq-key-example",
  },
  reply: (request) => ({ chunks: [`Got it: ${lastLine(request)}`] }),
  speechFetch: (async () => Response.json({ text: "A voice note" })) as unknown as typeof fetch,
});
setSurface(surfaceFromConfig(t.config));

const people: SurfacePeer["people"] = [];
for (const name of PEOPLE) {
  const person = browser(t);
  const email = `${name}@example.com`;
  await signUp(person, email);
  const created = await person("/api/app/organizations", {
    json: { name: `${name} and co`, context: "A company that sells tea." },
  });
  const orgId = ((await created.json()) as { organization: { id: string } }).organization.id;
  const credential = await person(`/api/app/organizations/${orgId}/credentials`, {
    json: { provider: "anthropic", label: "main", apiKey: "sk-ant-api-example-0000" },
  });
  if (credential.status !== 201) throw new Error(`credential not saved: ${credential.status}`);
  people.push({ email, cookie: person.cookie(), orgId });
}

const app = listen(t);
const bridgeFetch = operatorFetch({
  db: t.db,
  config: t.config,
  version: "peer",
  log: createLogger("error"),
  surface: t.services,
});
if (!bridgeFetch) throw new Error("the bridge did not start");
let down = false;
const bridge = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  maxRequestBodySize: 101 * 1024 * 1024,
  fetch: (req) =>
    down ? Response.json({ error: { code: "unavailable", message: "Down" } }, { status: 503 }) : bridgeFetch(req),
});

const door = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/emails") return Response.json(t.email.sent);
    if (req.method === "GET" && pathname === "/pushes") return Response.json(t.push.sent);
    if (req.method === "POST" && pathname === "/bridge") {
      down = ((await req.json()) as { down?: unknown }).down === true;
      return Response.json({ down });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  },
});

let draining = false;
setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    await t.drain();
  } catch (error) {
    console.error("drain failed", error);
  } finally {
    draining = false;
  }
}, 200);

const ready: SurfacePeer = {
  appUrl: `http://127.0.0.1:${app.port}`,
  bridgeUrl: `http://127.0.0.1:${bridge.port}`,
  doorUrl: `http://127.0.0.1:${door.port}`,
  token,
  origin: t.config.PUBLIC_URL,
  people,
};
console.log(JSON.stringify(ready));
