import { expect, test } from "bun:test";
import { helpEn } from "../src/help/pages.en";
import { helpPtBR } from "../src/help/pages.pt-BR";
import { en, ptBR } from "../src/index";
import { uncodedCommands } from "./command-code";

test("the app's words and the help pages show every command, path and setting as code", () => {
  expect([en, ptBR, helpEn, helpPtBR].flatMap((tree) => uncodedCommands(tree))).toEqual([]);
});

test("what reads as a command, and what doesn't", () => {
  const tree = {
    a: "Run agentes-runner doctor on it.",
    b: "Run `agentes-runner doctor` on it.",
    c: "Push with git push.",
    d: "Agents work in a git repository.",
    e: "Drag the ~/.openclaw folder.",
    f: "Set COMPOSIO_API_KEY.",
    g: "Or paste into <code>~/.cursor/mcp.json</code>:",
    h: "Claude and Codex sign in here.",
    i: "In %USERPROFILE% there.",
    j: { blocks: [{ code: "sudo loginctl enable-linger" }] },
    vault: { field: { keyNamePlaceholder: "ACME_API_KEY" } },
  };
  expect(uncodedCommands(tree)).toEqual([
    "a: Run agentes-runner doctor on it.",
    "c: Push with git push.",
    "e: Drag the ~/.openclaw folder.",
    "f: Set COMPOSIO_API_KEY.",
    "i: In %USERPROFILE% there.",
  ]);
});
