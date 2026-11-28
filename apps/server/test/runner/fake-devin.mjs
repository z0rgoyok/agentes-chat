// A fake Devin CLI (`devin`) for runner tests, speaking the Agent Client Protocol on `devin acp` the way Devin CLI
// 3000.14.30821 does (ADR 0253). `--version` prints that version; `models list --format json` the account's model
// families, or "Not logged in." (exit 1) where its home has no `credentials.toml`; `auth logout` removes it. Each
// start appends its argv, cwd, home folders, any `DEVIN_`/`WINDSURF_` env and its settings to $FAKE_DEVIN_LOG (one
// JSON line), and so does each request it gets and each permission answer.
//
// Sessions are kept in its data folder, as Devin's are: one that isn't there fails `session/load`. What the prompt
// says decides the turn: by default a paragraph, a call to our bridge, a shell command of its own that asks
// permission (`Exec(ls)`) and the answer, with tokens. "OUTSIDE": an edit outside the folder that asks
// (`Write(/etc/fake)`); "LIMIT": the plan's weekly quota; "AUTH": a refused sign-in; "SILENT": no answer at all.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// `--config <file>`: the settings to read instead of the user's (a turn's own).
const argv = process.argv.slice(2);
const configArg = argv[0] === "--config" ? argv[1] : undefined;
const args = configArg ? argv.slice(2) : argv;
const env = process.env;
const log = (entry) => {
  if (env.FAKE_DEVIN_LOG) appendFileSync(env.FAKE_DEVIN_LOG, `${JSON.stringify(entry)}\n`);
};
const dataDir = path.join(env.XDG_DATA_HOME ?? path.join(env.HOME ?? ".", ".local", "share"), "devin");
const creds = path.join(dataDir, "credentials.toml");

if (args[0] === "--version") {
  process.stdout.write("devin 3000.14.30821 (a09cd7f323ee)\n");
  process.exit(0);
}
if (args[0] === "models" && args[1] === "list") {
  log({ models: true, args });
  if (!existsSync(creds)) {
    process.stderr.write("Error: Not logged in. Run `devin auth login` to authenticate.\n");
    process.exit(1);
  }
  const variant = (model_uid, label, cost_tier, extra = {}) => ({
    model_uid,
    label,
    max_context_tokens: 262144,
    cost_tier,
    is_new: false,
    is_beta: false,
    ...extra,
  });
  process.stdout.write(
    JSON.stringify({
      families: [
        {
          family_label: "SWE-2",
          family_uid: "swe-2",
          slug: "swe-2",
          aliases: ["swe"],
          variants: [
            variant("swe-2-high", "SWE-2 High", "Free"),
            variant("swe-2-medium", "SWE-2 Medium", "Free"),
            variant("swe-2-max", "SWE-2 Max", "Free"),
            variant("swe-2-high-lightning", "SWE-2 High Lightning", "High cost"),
          ],
        },
        {
          family_label: "Claude Opus 5.5",
          family_uid: "claude-opus-5-5",
          slug: "claude-opus-5.5",
          aliases: [],
          variants: [
            variant("claude-opus-5-5-medium", "Claude Opus 5.5 Medium", "High cost", { max_context_tokens: 1000000 }),
            variant("claude-opus-5-5-low", "Claude Opus 5.5 Low", "High cost"),
            variant("claude-opus-5-5-xhigh", "Claude Opus 5.5 XHigh", "High cost"),
            variant("claude-opus-5-5-max", "Claude Opus 5.5 Max", "High cost"),
            variant("claude-opus-5-5-medium-fast", "Claude Opus 5.5 Medium Fast", "High cost"),
          ],
        },
        {
          family_label: "Fusion",
          family_uid: "fusion",
          slug: "fusion",
          aliases: [],
          variants: [
            variant(
              "fusion-claude-opus-5-5-medium-sidekick-swe-2-medium",
              "Fusion (Opus 5.5 Medium + SWE-2)",
              "High cost",
            ),
            variant("fusion-claude-opus-5-5-max-sidekick-swe-2-medium", "Fusion (Opus 5.5 Max + SWE-2)", "High cost"),
            variant("fusion-claude-opus-5-5-medium-sidekick-glm-5-2", "Fusion (Opus 5.5 Medium + GLM)", "High cost"),
          ],
        },
      ],
    }),
  );
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "logout") {
  rmSync(creds, { force: true });
  process.exit(0);
}
if (args[0] !== "acp") {
  process.stderr.write(`unknown command ${args[0]}\n`);
  process.exit(1);
}

const configFile =
  configArg ?? path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? ".", ".config"), "devin", "config.json");
log({
  start: true,
  pid: process.pid,
  args,
  configArg: configArg ?? null,
  cwd: process.cwd(),
  home: env.HOME ?? null,
  dataHome: env.XDG_DATA_HOME ?? null,
  configHome: env.XDG_CONFIG_HOME ?? null,
  devinEnv: Object.keys(env).filter((k) => /^(DEVIN_|WINDSURF_)/.test(k)),
  config: existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null,
  pwd: env.PWD ?? null,
});

const sessionsFile = path.join(dataDir, "fake-sessions.json");
const sessions = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : {};
const saveSessions = () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(sessionsFile, JSON.stringify(sessions));
};
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "swe-2-high";

let nextId = 1000;
const pending = new Map();
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const configOptions = (mode) => [
  {
    id: "mode",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: [{ value: "accept-edits" }, { value: "ask" }],
  },
  { id: "model", category: "model", type: "select", currentValue: "swe-2-high", options: [{ value: "swe-2-high" }] },
];

async function prompt(id, params) {
  const sid = params.sessionId;
  const text = params.prompt?.[0]?.text ?? "";
  sessions[sid].prompts.push(text);
  saveSessions();
  log({ method: "session/prompt", text, model: sessions[sid].model });
  if (text.includes("SILENT")) return;
  if (text.includes("LIMIT")) {
    return send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Internal error: Weekly quota exceeded. It resets in 3 days." },
    });
  }
  if (text.includes("AUTH")) {
    return send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Not logged in. Run `devin auth login` to authenticate." },
    });
  }
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working." } });
  update(sid, {
    sessionUpdate: "tool_call",
    toolCallId: "call_ours",
    title: "Calling post_message from agenteschat_agentes",
    rawInput: { body: "hi" },
    _meta: { "cognition.ai/toolName": "mcp__agenteschat_agentes__post_message" },
  });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_ours", status: "completed" });
  // "OWNRUN": a tool of its own that runs without asking (one its rules didn't cover).
  if (text.includes("OWNRUN")) {
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "call_run",
      title: "Read a.txt",
      rawInput: { path: "a.txt" },
      _meta: { "cognition.ai/inferenceToolName": "read" },
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_run",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "secret" } }],
    });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Read it." } });
    return send({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } },
    });
  }
  const outside = text.includes("OUTSIDE");
  update(sid, {
    sessionUpdate: "tool_call",
    toolCallId: "call_own",
    title: outside ? "Wrote /etc/fake" : "Ran ls",
    kind: outside ? "edit" : "execute",
    rawInput: outside ? { file_path: "/etc/fake" } : { command: "ls" },
    _meta: { "cognition.ai/inferenceToolName": outside ? "write" : "exec" },
  });
  const answer = await ask("session/request_permission", {
    sessionId: sid,
    toolCall: {
      toolCallId: "call_own",
      _meta: { "cognition.ai/permissionRule": outside ? "Write(/etc/fake)" : "Exec(ls)" },
    },
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  });
  log({ permissionAnswer: answer });
  const allowed = answer?.outcome?.optionId === "allow_once";
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_own",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: allowed ? "hello.txt" : "" } }],
  });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_own", status: allowed ? "completed" : "failed" });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  send({
    jsonrpc: "2.0",
    id,
    result: {
      stopReason: "end_turn",
      usage: { totalTokens: 1200, inputTokens: 1000, outputTokens: 100, cachedReadTokens: 100 },
    },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) {
      pending.get(m.id)?.(m.result);
      pending.delete(m.id);
      continue;
    }
    log({ method: m.method, params: m.params });
    if (m.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
          authMethods: [{ id: "devin-browser", name: "Log in with browser" }],
          agentInfo: { name: "affogato", title: "Devin Agent", version: "3000.14.30821" },
        },
      });
    } else if (m.method === "session/new") {
      const sid = `fake-${Object.keys(sessions).length + 1}`;
      sessions[sid] = { prompts: [], model, cwd: m.params.cwd };
      saveSessions();
      send({ jsonrpc: "2.0", id: m.id, result: { sessionId: sid, configOptions: configOptions("accept-edits") } });
    } else if (m.method === "session/load") {
      const s = sessions[m.params.sessionId];
      if (!s) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Session not found" } });
        continue;
      }
      for (const p of s.prompts)
        update(m.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: p } });
      send({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions("accept-edits") } });
    } else if (m.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions(m.params.value) } });
    } else if (m.method === "session/prompt") {
      void prompt(m.id, m.params);
    } else if (m.method === "session/cancel") {
      // nothing runs on its own
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
