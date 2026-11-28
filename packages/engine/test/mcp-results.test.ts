import { expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { mcpSessionOver } from "../src";

/** A server answering like GitHub's `get_file_contents`: a status line, then the file as an embedded resource. */
async function session() {
  const server = new McpServer({ name: "files", version: "1" });
  server.registerTool("get_file_contents", { description: "Get a file" }, async () => ({
    content: [
      { type: "text" as const, text: "successfully downloaded text file (SHA: 34f0320)" },
      {
        type: "resource" as const,
        resource: {
          uri: "repo://acme/app/contents/docs/adr/0001.md",
          mimeType: "text/markdown",
          text: "# Early access\n\nSign-up is open.",
        },
      },
      {
        type: "resource" as const,
        resource: { uri: "repo://acme/app/contents/logo.png", mimeType: "image/png", blob: "iVBORw0KGgo=" },
      },
    ],
  }));
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  return mcpSessionOver(client);
}

test("a file sent as an embedded resource reaches the agent as its text; a binary one stays a placeholder", async () => {
  const s = await session();
  const out = await s.callTool("get_file_contents", {});
  expect(out.isError).toBe(false);
  expect(out.content).toBe(
    "successfully downloaded text file (SHA: 34f0320)\n# Early access\n\nSign-up is open.\n[resource]",
  );
  await s.close();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

test("an image block reaches the agent as the picture itself; one no AI reads, or past the size, says why", async () => {
  const server = new McpServer({ name: "charts", version: "1" });
  const big = Buffer.concat([PNG, Buffer.alloc(3_600_000)]);
  server.registerTool("render_chart", { description: "Render a chart" }, async () => ({
    content: [
      { type: "text" as const, text: "Sales by month" },
      // Wrapped in lines, as some servers send base64: the picture goes on as one line.
      { type: "image" as const, data: PNG.toString("base64").replace(/(.{4})/g, "$1\n"), mimeType: "image/png" },
      { type: "image" as const, data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" },
      { type: "image" as const, data: big.toString("base64"), mimeType: "image/png" },
    ],
  }));
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  const s = await mcpSessionOver(client);
  const out = await s.callTool("render_chart", {});
  expect(out.images).toEqual([{ mediaType: "image/png", data: PNG.toString("base64") }]);
  expect(out.content).toBe(
    [
      "Sales by month",
      "[image: shown to you with this result]",
      "[image (image/svg+xml): not a PNG, JPEG, GIF or WebP, so not shown to you]",
      "[image of 3.4 MB: past the 3.3 MB of pictures an AI is shown at once, so not shown to you]",
    ].join("\n"),
  );
  await s.close();
});

/** Twenty tools, each with an output schema of 40 columns a row. */
async function reports() {
  const server = new McpServer({ name: "reports", version: "1" });
  const row = z.object(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`column_${i}`, z.string()])));
  for (let i = 0; i < 20; i++) {
    server.registerTool(`report_${i}`, { description: "A report", outputSchema: { rows: z.array(row) } }, async () => ({
      content: [{ type: "text" as const, text: "[]" }],
      structuredContent: { rows: [] },
    }));
  }
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  return client;
}

test("listing tools compiles none of their output schemas", async () => {
  const compiles = spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
  try {
    const s = await mcpSessionOver(await reports());
    expect(await s.listTools()).toHaveLength(20);
    expect(compiles).not.toHaveBeenCalled();
    await s.close();
    // The SDK's default: every listing compiles each one again, with a new Ajv for every client.
    const plain = new Client({ name: "plain", version: "1" });
    await plain.connect(await reports());
    await plain.listTools();
    expect(compiles).toHaveBeenCalledTimes(20);
    await plain.close();
  } finally {
    compiles.mockRestore();
  }
});
