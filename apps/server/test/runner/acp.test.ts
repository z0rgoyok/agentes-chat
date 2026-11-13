import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ACP_METHOD_NOT_FOUND, AcpConnection, AcpError } from "../../runner/acp";

/** A connection whose other end is the test: what it wrote, and a way to answer as the agent. */
function wired(handlers: ConstructorParameters<typeof AcpConnection>[2] = {}) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  let pending = "";
  toAgent.setEncoding("utf8");
  toAgent.on("data", (chunk: string) => {
    pending += chunk;
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      sent.push(JSON.parse(pending.slice(0, at)));
      pending = pending.slice(at + 1);
    }
  });
  const conn = new AcpConnection(toAgent, fromAgent, handlers);
  const agent = (message: unknown) => fromAgent.write(`${JSON.stringify(message)}\n`);
  return { conn, sent, agent, fromAgent };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test("a request gets its own answer by id; an error answer rejects with its code, words and data", async () => {
  const { conn, sent, agent } = wired();
  const first = conn.request("initialize", { protocolVersion: 1 });
  const second = conn.request("session/new", { cwd: "/w" });
  await tick();
  expect(sent).toEqual([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
    { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/w" } },
  ]);
  // Answers may come in any order.
  agent({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32602, message: "Invalid params: session not found", data: { a: 1 } },
  });
  agent({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  expect(await first).toEqual({ protocolVersion: 1 });
  const refused = await second.catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(AcpError);
  expect(refused).toMatchObject({ code: -32602, message: "Invalid params: session not found", data: { a: 1 } });
});

test("the agent's notifications reach their handler; its requests are answered, unknown ones as not found", async () => {
  const notes: unknown[] = [];
  const { sent, agent } = wired({
    onNotification: (method, params) => notes.push({ method, params }),
    onRequest: (method, params) => {
      if (method === "session/request_permission") return { outcome: { outcome: "selected", optionId: "reject" } };
      if (method === "fs/read_text_file")
        throw new AcpError(-32001, "No files here", { path: (params as { path: string }).path });
      throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
    },
  });
  agent({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "plan" } } });
  agent({ jsonrpc: "2.0", id: "p1", method: "session/request_permission", params: {} });
  agent({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
  agent({ jsonrpc: "2.0", id: 8, method: "terminal/create", params: {} });
  await tick();
  expect(notes).toEqual([{ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "plan" } } }]);
  // Each answer goes out when it's ready, in any order (JSON-RPC matches them by id).
  expect(sent).toHaveLength(3);
  expect(sent).toEqual(
    expect.arrayContaining([
      { jsonrpc: "2.0", id: "p1", result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { jsonrpc: "2.0", id: 7, error: { code: -32001, message: "No files here", data: { path: "/etc/passwd" } } },
      { jsonrpc: "2.0", id: 8, error: { code: ACP_METHOD_NOT_FOUND, message: "Method not found: terminal/create" } },
    ]),
  );
});

test("lines split across chunks are read whole; a stray line that isn't JSON is skipped", async () => {
  const notes: string[] = [];
  const { fromAgent } = wired({ onNotification: (method) => notes.push(method) });
  fromAgent.write('{"jsonrpc":"2.0","method":"a"}\nnot json\n{"jsonrpc":"2.0",');
  fromAgent.write('"method":"b"}\n');
  await tick();
  expect(notes).toEqual(["a", "b"]);
});

test("the connection ending rejects every request still waiting, and any sent after", async () => {
  const { conn, fromAgent } = wired();
  const waiting = conn.request("session/prompt", {});
  fromAgent.end();
  await expect(waiting).rejects.toThrow("The agent closed its output");
  expect(conn.closed?.message).toBe("The agent closed its output");
  await expect(conn.request("session/prompt", {})).rejects.toThrow("The agent closed its output");
  // Closing again keeps the first reason.
  conn.close(new Error("later"));
  expect(conn.closed?.message).toBe("The agent closed its output");
});

test("what it last heard: any line from the agent", async () => {
  const { conn, agent } = wired();
  conn.lastHeard = 0;
  agent({ jsonrpc: "2.0", method: "session/update", params: {} });
  await tick();
  expect(Date.now() - conn.lastHeard).toBeLessThan(1000);
});
