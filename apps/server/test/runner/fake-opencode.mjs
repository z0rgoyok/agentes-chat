// A fake OpenCode CLI (`opencode`) for runner tests, speaking the Agent Client Protocol on `opencode acp` the way
// OpenCode 1.19.5 or 2.2.7 does ($FAKE_OPENCODE_VERSION: "1" or "2", the default). `--version` prints that version,
// `models` OpenCode's free models (and a paid one when a key is in the config). Each start appends its argv, cwd and the
// env that matters to $FAKE_OPENCODE_LOG (one JSON line), and so does each request it gets.
//
// Sessions are kept in its data folder (`XDG_DATA_HOME`), as OpenCode's are: one that isn't there fails
// `session/resume`. What the prompt says decides the turn: by default a paragraph, a shell call of its own (none with `*`
// denied: OpenCode hides its tools then), a call to
// our bridge and the answer, with tokens. "LIMIT": a provider's limit; "BADKEY": a refused key; "SILENT": no answer at
// all; "SLEEP": a tool that runs until `session/cancel`; "OWNTOOL": a tool of its own that waits to be stopped; "ASK":
// a permission request (2.x then ends the turn, 1.x goes on); "STEER": a tool running until `_session/steering` (2.x)
// then a new step; "ENV": the shell printing $OPENCODE_API_KEY. Once its input closes it exits, "LINGER" a moment
// later (logged), "STUCK" never by itself, nor on SIGTERM.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.env;
const v2 = (env.FAKE_OPENCODE_VERSION ?? "2") !== "1";
const log = (entry) => {
  if (env.FAKE_OPENCODE_LOG) appendFileSync(env.FAKE_OPENCODE_LOG, `${JSON.stringify(entry)}\n`);
};

if (args[0] === "--version") {
  process.stdout.write(v2 ? "opencode v2.2.7\n" : "1.19.5\n");
  process.exit(0);
}
if (args[0] === "models") {
  log({ models: true, args });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
  const paid = config.provider?.opencode ? "opencode/glm-5.3\n" : "";
  process.stdout.write(`opencode/big-pickle\nopencode/glm-5.3-flash-free\n${paid}`);
  process.exit(0);
}
if (args[0] !== "acp") {
  process.stderr.write(`unknown command ${args[0]}\n`);
  process.exit(1);
}

const configDir = env.OPENCODE_CONFIG_DIR ?? "";
log({
  start: true,
  pid: process.pid,
  args,
  cwd: process.cwd(),
  dataHome: env.XDG_DATA_HOME ?? null,
  configHome: env.XDG_CONFIG_HOME ?? null,
  configDir: env.OPENCODE_CONFIG_DIR ?? null,
  configEntries: configDir && existsSync(configDir) ? readdirSync(configDir).sort() : [],
  config: env.OPENCODE_CONFIG_CONTENT ?? null,
  permission: env.OPENCODE_PERMISSION ?? null,
  apiKey: env.OPENCODE_API_KEY ?? null,
  anthropicKey: env.ANTHROPIC_API_KEY ?? null,
  projectConfig: env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
  lspDownload: env.OPENCODE_DISABLE_LSP_DOWNLOAD ?? null,
  claudeCode: env.OPENCODE_DISABLE_CLAUDE_CODE ?? null,
  pwd: env.PWD ?? null,
  ghConfig: env.GH_CONFIG_DIR ?? null,
});

// Each session with its own model, as OpenCode keeps them.
const store = path.join(env.XDG_DATA_HOME || env.HOME || ".", "fake-opencode-sessions.json");
const sessions = () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {});
const keep = (id, model) => {
  mkdirSync(path.dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify({ ...sessions(), [id]: model }));
};

const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
const locked = config.permission?.["*"] === "deny";
let askId = 0;
let lingerMs = 0;
let stuck = false;
const asked = new Map();
let running = null;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `ask${++askId}`;
    asked.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const configOptions = (model) => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [{ value: model, name: model }] },
];
const text = (t) => [{ type: "content", content: { type: "text", text: t } }];
const USAGE = { inputTokens: 900, outputTokens: 30, thoughtTokens: 10, cachedReadTokens: 100, totalTokens: 1040 };

async function prompt(id, params) {
  const sid = params.sessionId;
  const said = params.prompt.map((b) => b.text ?? "").join("");
  log({ method: "session/prompt", sessionId: sid, text: said });
  if (said.includes("LINGER")) lingerMs = 150;
  if (said.includes("STUCK")) {
    stuck = true;
    process.on("SIGTERM", () => log({ sigterm: true }));
  }
  // OpenCode 2 names its tools; 1.x only in the first title.
  const own = v2 ? { name: "shell", title: "shell" } : { title: "bash" };
  const cancelled = new Promise((resolve) => {
    running = { sessionId: sid, cancel: resolve, steer: null };
  });
  const done = (stopReason, usage = USAGE) => {
    running = null;
    send({ jsonrpc: "2.0", id, result: { stopReason, usage } });
  };
  const fail = (code, message, data) => {
    running = null;
    send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  };
  if (said.includes("LIMIT")) {
    return v2
      ? fail(-32603, "Internal error: Free usage limit reached. Subscribe to OpenCode Go to keep going.", {
          service: "session",
          errorName: "provider.free-limit",
        })
      : fail(-32603, "Internal error: rate limit exceeded (429)", { service: "session" });
  }
  if (said.includes("BADKEY")) {
    return v2
      ? fail(-32603, "Internal error: Unauthorized: invalid api key", { errorName: "provider.auth" })
      : fail(-32000, "Authentication required");
  }
  if (said.includes("SILENT")) return;
  if (said.includes("SLEEP") || said.includes("OWNTOOL")) {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "call_s", ...own, kind: "execute", status: "pending" });
    await cancelled;
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_s",
      status: "failed",
      content: text("Tool execution interrupted"),
    });
    return done("cancelled", { inputTokens: 10, outputTokens: 1 });
  }
  if (said.includes("ASK")) {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "call_ask", ...own, kind: "execute", status: "pending" });
    const answer = await ask("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "call_ask", title: "curl example.com", kind: "execute" },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
    log({ permissionAnswer: answer });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_ask",
      status: "failed",
      content: text("The user rejected permission to use this specific tool call."),
    });
    // 2.x ends the whole turn on a refused request; 1.x only fails that call.
    if (v2) return done("cancelled");
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_2",
      content: { type: "text", text: "I couldn't run it." },
    });
    return done("end_turn");
  }
  if (said.includes("STEER")) {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "call_1", ...own, kind: "execute", status: "pending" });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      rawInput: { command: "sleep 1" },
    });
    await new Promise((resolve) => {
      running.steer = resolve;
      setTimeout(resolve, 3000);
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: text("slept"),
    });
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_2",
      content: { type: "text", text: "Steered." },
    });
    return done("end_turn");
  }
  update(sid, {
    sessionUpdate: "agent_message_chunk",
    messageId: "msg_1",
    content: { type: "text", text: "Let me check." },
  });
  // With `*` denied OpenCode offers the model none of its own tools: only ours.
  if (!locked) {
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      ...own,
      kind: "execute",
      status: "pending",
      rawInput: {},
    });
    const command = said.includes("ENV") ? "echo $OPENCODE_API_KEY" : "ls";
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      ...(v2 ? {} : { title: command }),
      rawInput: { command },
    });
    const output = said.includes("ENV") ? `${env.OPENCODE_API_KEY ?? ""}\n` : "a.txt\n";
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: text(output),
    });
  }
  update(sid, {
    sessionUpdate: "tool_call",
    toolCallId: "call_2",
    ...(v2 ? { name: "agenteschat_agentes_post" } : {}),
    title: "agenteschat_agentes_post",
    kind: "other",
    status: "pending",
  });
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_2",
    status: "completed",
    content: text("posted"),
  });
  update(sid, { sessionUpdate: "agent_message_chunk", messageId: "msg_2", content: { type: "text", text: "All " } });
  update(sid, { sessionUpdate: "agent_message_chunk", messageId: "msg_2", content: { type: "text", text: "good." } });
  update(sid, { sessionUpdate: "usage_update", used: 1040, size: 200000 });
  done("end_turn");
}

function handle(m) {
  if (m.method === undefined && m.id !== undefined) {
    asked.get(m.id)?.(m.result ?? m.error);
    asked.delete(m.id);
    return;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const error = (code, message, data) =>
    send({ jsonrpc: "2.0", id: m.id, error: { code, message, ...(data ? { data } : {}) } });
  if (m.method !== "session/prompt") log({ method: m.method, params: m.params });
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { image: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        agentInfo: { name: "OpenCode", version: v2 ? "2.2.7" : "1.19.5" },
        ...(v2 ? { _meta: { steering: { supported: true } } } : {}),
      });
    case "session/new": {
      const id = `ses_fake${String(Object.keys(sessions()).length + 1).padStart(4, "0")}`;
      const model = config.model ?? "opencode/big-pickle";
      keep(id, model);
      return reply({ sessionId: id, configOptions: configOptions(model) });
    }
    case "session/resume":
      if (!(m.params.sessionId in sessions())) {
        return v2
          ? error(-32602, `Invalid params: session not found: ${m.params.sessionId}`, { sessionId: m.params.sessionId })
          : error(-32603, "Internal error: OpenCode service failure", { service: "session" });
      }
      return reply({ configOptions: configOptions(sessions()[m.params.sessionId]) });
    case "session/set_config_option":
      if (m.params.value === "opencode/missing") {
        return error(-32602, `Invalid params: model not found: ${m.params.value}`);
      }
      keep(m.params.sessionId, m.params.value);
      return reply({ configOptions: configOptions(m.params.value) });
    case "session/prompt":
      return void prompt(m.id, m.params);
    case "session/cancel":
      running?.cancel();
      return;
    case "_session/steering":
      if (!v2) return error(-32601, '"Method not found": _session/steering');
      if (!running) return reply({ outcome: "promptRequired", reason: "noRunningTurn" });
      running.steer?.();
      return reply({ outcome: "injected" });
    default:
      if (m.id !== undefined) error(-32601, `Method not found: ${m.method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (stuck) {
    setInterval(() => {}, 1000);
    return;
  }
  if (!lingerMs) process.exit(0);
  setTimeout(() => {
    log({ exited: true });
    process.exit(0);
  }, lingerMs);
});
