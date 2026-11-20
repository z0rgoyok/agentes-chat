import { expect, test } from "bun:test";
import { serverKey } from "../src/connectors/oauth-mcp";

test("one MCP address has one key however it was typed", () => {
  const key = "https://mcp.example.com/sse";
  for (const typed of [key, `${key}/`, `${key}///`, "HTTPS://MCP.Example.com/SSE/"]) expect(serverKey(typed)).toBe(key);
  expect(serverKey("https://mcp.example.com/a/b")).toBe("https://mcp.example.com/a/b");
  expect(serverKey("https://mcp.example.com//a")).toBe("https://mcp.example.com//a");
  expect(serverKey("///")).toBe("");
  expect(serverKey("")).toBe("");
});

test("an address made of a long run of slashes is read once", () => {
  const run = "/".repeat(200_000);
  const started = performance.now();
  expect(serverKey(`https://mcp.example.com${run}a`)).toBe(`https://mcp.example.com${run}a`);
  expect(serverKey(`https://mcp.example.com${run}`)).toBe("https://mcp.example.com");
  expect(performance.now() - started).toBeLessThan(1_000);
});
