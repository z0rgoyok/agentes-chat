import { expect, test } from "bun:test";
import { proxyBaseAt } from "../../runner/git";

const BASE = "https://chat.example.com/api/git/org-1/conn-1/";

test("the git proxy is reached at the address the runner reaches its server at", () => {
  // This server's own computer, or a server whose public name the computer doesn't resolve.
  expect(proxyBaseAt(BASE, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/api/git/org-1/conn-1/");
  expect(proxyBaseAt(BASE, "https://internal.example.net/agentes/")).toBe(
    "https://internal.example.net/agentes/api/git/org-1/conn-1/",
  );
  // The same address, none, or one that isn't an address: as the server named it.
  expect(proxyBaseAt(BASE, "https://chat.example.com")).toBe(BASE);
  expect(proxyBaseAt(BASE, undefined)).toBe(BASE);
  expect(proxyBaseAt(BASE, "not a url")).toBe(BASE);
  expect(proxyBaseAt(BASE, "ws://chat.example.com")).toBe(BASE);
});
