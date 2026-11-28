// A fake `agent-desktop` for the apps tests: prints one JSON envelope like the real one.
// Each run appends `{ args, stdin, home }` to $FAKE_AD_LOG (one JSON line; `home` is AGENT_DESKTOP_HOME).
// $FAKE_AD_STATE (JSON) shapes the answers: `{ app, window, snapshot, fail: { <command>: { code, retry } } }`.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdin = argv.includes("--stdin")
  ? await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (c) => {
        data += c;
      });
      process.stdin.on("end", () => resolve(data));
    })
  : "";
if (process.env.FAKE_AD_LOG) {
  appendFileSync(
    process.env.FAKE_AD_LOG,
    `${JSON.stringify({ args: argv, stdin, home: process.env.AGENT_DESKTOP_HOME ?? null })}\n`,
  );
}
const state =
  process.env.FAKE_AD_STATE && existsSync(process.env.FAKE_AD_STATE)
    ? JSON.parse(readFileSync(process.env.FAKE_AD_STATE, "utf8"))
    : {};
const command = argv[0];
const print = (v) => process.stdout.write(`${JSON.stringify({ version: "2.6", command, ...v })}\n`);
const failure = state.fail?.[command];
if (failure) {
  print({
    ok: false,
    error: { code: failure.code, message: `${command} failed`, disposition: { retry: failure.retry ?? "safe" } },
  });
  process.exit(1);
}
const appArg = argv.includes("--app") ? argv[argv.indexOf("--app") + 1] : undefined;
const snapshotId = state.snapshot ?? "s1abc";
switch (command) {
  // As the real one: a find names neither its app nor its window, only each match's path.
  case "find":
    print({
      ok: true,
      data: {
        snapshot_id: snapshotId,
        matches: [
          {
            role: "button",
            name: "Send",
            ref_id: `@${snapshotId}:e1`,
            path: [`window:${state.window ?? "Inbox"}`, "group"],
          },
        ],
      },
    });
    break;
  case "snapshot":
    print({
      ok: true,
      data: {
        app: state.app ?? appArg,
        snapshot_id: snapshotId,
        complete: true,
        ...(state.window && !state.noWindowField ? { window: { id: "w-1", title: state.window } } : {}),
        tree: {
          role: "window",
          name: state.window ?? "Inbox",
          children: [
            { role: "button", name: "Send", ref_id: `@${snapshotId}:e1`, available_actions: ["Click"] },
            { role: "textfield", name: "Subject", ref_id: `@${snapshotId}:e2`, value: "" },
          ],
        },
      },
    });
    break;
  case "list-apps":
    print({ ok: true, data: { apps: [{ name: "Mail" }, { name: "agentes.chat" }, { name: "Finder" }] } });
    break;
  default:
    print({ ok: true, data: { action: command, disposition: { delivery: "delivered_unverified", retry: "unsafe" } } });
}
