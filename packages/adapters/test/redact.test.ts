import { expect, test } from "bun:test";
import { errorLineOf } from "../src/redact";

test("a crash's error line, without its stack frames or the Node.js version it ends with", () => {
  const crash = [
    "node:internal/modules/cjs/loader:1228",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module '/x/cli.js'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
    "    at /usr/lib/node_modules/x/cli.js:1:2",
    "    at file:///usr/lib/x.mjs:3:4",
    "",
    "Node.js v22.1.0",
  ].join("\n");
  expect(errorLineOf(crash)).toBe("Error: Cannot find module '/x/cli.js'");
  expect(errorLineOf("TypeError: boom    at f (/a/b.js:1:2)")).toBe("TypeError: boom");
  expect(errorLineOf("just one line\n")).toBe("just one line");
  expect(errorLineOf("")).toBe("");
});

test("output full of spaces is read in linear time", () => {
  const spaces = " ".repeat(200_000);
  const started = performance.now();
  expect(errorLineOf(`${spaces}x${spaces}`)).toBe("x");
  expect(errorLineOf(`Error: late${"\n ".repeat(50_000)}at`)).toBe("Error: late");
  expect(performance.now() - started).toBeLessThan(1000);
});
