import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, ProviderError } from "@agenteschat/providers";
import {
  drainOutbox,
  HOW_YOU_WORK,
  MAX_MESSAGE_LENGTH,
  postPersonMessage,
  type ToolContext,
  type ToolSource,
} from "../src";
import { CONTINUE_AFTER_CUT, CUT_AT_OUTPUT_LIMIT } from "../src/executor";
import { syntaxError } from "../src/file-syntax";
import { type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";

// PGlite setup on a slow machine.
setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("syntaxError", () => {
  const error = async (path: string, text: string) => (await syntaxError(path, text))?.error ?? null;

  test("names the line and column of a script that doesn't parse", async () => {
    expect(await error("campaign.gs", "function main() {\n  if (a {\n  }\n}")).toStartWith("line 2, column 9: ");
    expect(await error("run.js", "function main() {\n  return `x ${")).toContain("Unexpected end of file");
    expect(await syntaxError("index.ts", "const a: number = (\n")).toEqual({
      format: "TypeScript",
      error: "line 1, column 20: Unexpected end of file",
    });
  });

  test("names the line and column of JSON, YAML and TOML that don't parse", async () => {
    expect(await syntaxError("data/config.json", '{\n  "a": 1,\n}')).toEqual({
      format: "JSON",
      error: "line 2, column 9: JSON does not support trailing commas",
    });
    expect(await syntaxError(".github/workflows/ci.yml", "jobs:\n\tbuild: 1\n")).toEqual({
      format: "YAML",
      error: "line 2, column 2: Tab characters cannot be used as indentation",
    });
    expect(await error("pyproject.toml", "[project]\nname = \n")).toStartWith("line 2, column 8: ");
    expect(await error("C:\\work\\.vscode\\launch.json", "{\n  // run\n  ]")).toStartWith("line 3, column 3: ");
    expect(await error("settings.jsonc", '{\n  // note\n  "a": 1\n  "b": 2\n}')).toStartWith("line 4, column 3: ");
    expect(await error("app/package.json", '{\n  "name": "app",\n}')).toStartWith("line 2, column 16: ");
    expect(await error("ci.yml", "env:\n  T: $" + "{{ secrets.T }}\n\tx: 1\n")).toStartWith("line 3, column 2: ");
  });

  test("passes modern and sloppy-mode scripts, typed code and data that parse, and leaves other files alone", async () => {
    const script =
      "function main() {\n  const ids = [...new Set([1, 2])];\n  return ids?.length ?? 0;\n}\nwith (o) { p(); }";
    expect(await syntaxError("campaign.gs", script)).toBeNull();
    expect(await syntaxError("App.jsx", "const v = <div />;")).toBeNull();
    expect(await syntaxError("id.ts", "const id = <T,>(x: T): T => x;\nenum E { A }")).toBeNull();
    expect(await syntaxError("App.tsx", "const v = <div title={String(1 as number)} />;")).toBeNull();
    expect(await syntaxError("tsconfig.json", '{\n  // strict\n  "compilerOptions": {},\n}')).toBeNull();
    expect(await syntaxError(".vscode/settings.json", '{\n  // tabs\n  "editor.tabSize": 2,\n}')).toBeNull();
    expect(await syntaxError("stack.yaml", "Name: !Ref Bucket\nbase: &b\n  k: 1\nother:\n  <<: *b\n")).toBeNull();
    expect(await syntaxError("Cargo.toml", '[package]\nname = "app"\n')).toBeNull();
    expect(await syntaxError("chart/templates/app.yaml", "metadata:\n  {{- if .Values.on }}\n  a: 1\n")).toBeNull();
    for (const path of ["notes.md", "job.py", "query.sql", "run.sh"])
      expect(await syntaxError(path, "if (a {")).toBeNull();
  });
});

describe("write_file", () => {
  async function ctxOf(): Promise<ToolContext> {
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev oi",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
    if (!run) throw new Error("no run");
    return {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: run.threadRootId,
      triggerMessageId: msg.id,
    };
  }
  const call = async (ctx: ToolContext, input: Record<string, unknown>) => {
    const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name: "write_file", input });
    if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
    return outcome.output;
  };

  test("a script that doesn't parse says where; parts added with append make one file, checked whole", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f);
    const ctx = await ctxOf();

    const first = await call(ctx, { path: "out/campaign.gs", content: "function main() {\n  const a = 1;\n" });
    expect(first.isError).toBeFalsy();
    expect(first.content).toStartWith("Wrote out/campaign.gs (33 bytes). It doesn't parse as JavaScript yet (line 2");

    const rest = await call(ctx, { path: "out/campaign.gs", content: "  return a;\n}\n", append: true });
    expect(rest.content).toBe("Added 14 bytes to out/campaign.gs (47 bytes now).");
    const key = [...runner.files.keys()].find((k) => k.endsWith("out/campaign.gs")) as string;
    expect(new TextDecoder().decode(runner.files.get(key))).toBe("function main() {\n  const a = 1;\n  return a;\n}\n");

    expect((await call(ctx, { path: "notes.md", content: "if (a {" })).content).toBe("Wrote notes.md (7 bytes).");
    expect((await call(ctx, { path: "deploy.yml", content: "a: [1\n" })).content).toStartWith(
      "Wrote deploy.yml (6 bytes). It doesn't parse as YAML yet (line 1, column 6: ",
    );
  });

  test("append leaves a file holding a saved key as it is: the key reads back hidden", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { runner } = await connectedComputer(f);
    const ctx = await ctxOf();
    await call(ctx, { path: "config.ini", content: "token=[secret:API_KEY]\n" });

    const added = await call(ctx, { path: "config.ini", content: "region=eu\n", append: true });
    expect(added.isError).toBe(true);
    expect(added.content).toContain("holds a saved key");
    const key = [...runner.files.keys()].find((k) => k.endsWith("config.ini")) as string;
    expect(new TextDecoder().decode(runner.files.get(key))).toBe("token=[secret:API_KEY]\n");
  });
});

describe("a call cut at the output limit", () => {
  test("never runs; the model is told why and goes on to answer", async () => {
    let saved = 0;
    const SAVE: ToolSource = {
      name: "save",
      tools: async () => [
        {
          name: "save_text",
          description: "Save text",
          scope: "",
          inputSchema: { type: "object" },
          execute: async () => {
            saved++;
            return { content: "saved" };
          },
        },
      ],
    };
    f = await setup({
      toolSources: [SAVE],
      reply: (_req, call) =>
        call === 1
          ? {
              chunks: [],
              toolUses: [{ name: "save_text", input: { text: "function main() {" } }],
              stopReason: "max_tokens",
            }
          : { chunks: ["Salvei em partes."] },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev escreve o script",
    });
    await drainOutbox(f.db, f.handlers);

    expect(saved).toBe(0);
    const second = f.provider.calls[1]?.request as ModelRequest;
    expect(JSON.stringify(second.messages.at(-1)?.content)).toContain(CUT_AT_OUTPUT_LIMIT);
    const posted = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
    expect(posted.map((m) => m.body)).toEqual(["Salvei em partes."]);
  });
});

describe("a reply cut at the output limit", () => {
  test("goes on in the next call, and its parts are posted as one reply", async () => {
    f = await setup({
      reply: (_req, call) =>
        call === 1 ? { chunks: ["Primeira metade, "], stopReason: "max_tokens" } : { chunks: ["segunda metade."] },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev escreve o texto todo",
    });
    await drainOutbox(f.db, f.handlers);

    const second = f.provider.calls[1]?.request as ModelRequest;
    expect(second.messages.at(-1)?.content).toBe(CONTINUE_AFTER_CUT);
    const posted = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
    expect(posted.map((m) => m.body)).toEqual(["Primeira metade, segunda metade."]);
  });

  test("its next call failing: what it wrote so far is posted, and the run fails", async () => {
    f = await setup({
      reply: (_req, call) =>
        call === 1
          ? { chunks: ["Primeira metade, "], stopReason: "max_tokens" }
          : new ProviderError("provider rejected the request (400): bad request", false, 400),
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev escreve o texto todo",
    });
    await drainOutbox(f.db, f.handlers);

    const posted = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
    expect(posted.map((m) => m.body)).toContain("Primeira metade,");
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("failed");
  });

  test("all thinking twice in a row: it goes on no more, so a model that only thinks never runs the run's steps out", async () => {
    f = await setup({
      reply: () => ({
        chunks: [],
        opaque: [{ type: "thinking", thinking: "", signature: "sig-1" }],
        stopReason: "max_tokens",
      }),
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev escreve o texto todo",
    });
    await drainOutbox(f.db, f.handlers);

    // Two calls each time it is told to answer, as with any reply that says nothing; never the run's 200 steps.
    expect(f.provider.calls.length).toBeLessThanOrEqual(6);
  });
});

describe("a reply longer than one message", () => {
  test("posts as consecutive messages in its place, cut between paragraphs, a code block closed and opened again", async () => {
    const prose = `${"Uma frase de texto corrido. ".repeat(2000)}`.trim();
    const code = Array.from({ length: 4000 }, (_, i) => `const line${i} = ${i}; // the code goes on`).join("\n");
    const reply = `${prose}\n\n${prose}\n\n\`\`\`ts\n${code}\n\`\`\`\n\nE pronto.`;
    expect(reply.length).toBeGreaterThan(MAX_MESSAGE_LENGTH);
    f = await setup({ reply: () => ({ chunks: [reply] }) });
    const events = f.listen(f.general.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev escreve tudo",
    });
    await drainOutbox(f.db, f.handlers);

    const posted = (await f.db.select().from(schema.messages))
      .filter((m) => m.authorType === "agent")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    expect(posted.length).toBeGreaterThan(1);
    for (const m of posted) {
      expect(m.body.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(m.threadId).toBe(posted[0]?.threadId ?? null);
      // Every part's fences pair up: no part leaves a code block open.
      expect((m.body.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(posted[0]?.body.startsWith("Uma frase")).toBe(true);
    expect(posted.at(-1)?.body.endsWith("E pronto.")).toBe(true);
    const words = posted.map((m) => m.body.replace(/^```(ts)?$/gm, "")).join("\n");
    expect(words.replace(/\s+/g, " ")).toBe(reply.replace(/^```(ts)?$/gm, "").replace(/\s+/g, " "));
    // What shows once under a reply is on its last part alone.
    expect(posted.map((m) => "work" in m.meta)).toEqual(posted.map((_, i) => i === posted.length - 1));
    // The apps hear every part, in order.
    const created = events.flatMap((e) => (e.type === "message.created" ? [e.messageId] : []));
    expect(created.filter((id) => posted.some((m) => m.id === id))).toEqual(posted.map((m) => m.id));
    // One reply: it notifies once, from its first part, and is routed once, from its last.
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) =>
      posted.some((m) => m.id === j.payload.messageId),
    );
    const of = (kind: string) => jobs.filter((j) => j.kind === kind).map((j) => j.payload.messageId);
    expect(of("notifications.message")).toEqual([posted[0]?.id]);
    expect(of("message.posted")).toEqual([posted.at(-1)?.id]);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
  });
});

test("the prompt: code for a platform the agent can't run starts from the working version and is checked", () => {
  expect(HOW_YOU_WORK).toContain("start from the person's last working version and change only what is asked");
  expect(HOW_YOU_WORK).toContain("in the platform's current docs on the web");
  expect(HOW_YOU_WORK).toContain("A request now beats a rule built into that version.");
});
