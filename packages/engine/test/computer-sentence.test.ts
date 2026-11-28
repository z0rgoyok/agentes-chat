import { expect, test } from "bun:test";
import { computerSentence } from "../src/sandbox-tools";

test("what an agent reads about a connected computer names agentes.chat, never the runner", () => {
  const words = computerSentence({
    kind: "machine",
    name: "Ana's Mac",
    os: "darwin",
    managed: false,
    online: true,
    machineId: "m1",
    execAllowed: true,
    system: false,
    protocol: 99,
    paused: null,
    folders: [],
    maintenance: null,
  });
  expect(words).toContain("as the user agentes.chat runs as there");
  expect(words).not.toMatch(/runner/i);
});
