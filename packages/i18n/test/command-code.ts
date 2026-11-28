import { leaves } from "./leaves";

/** Tools a person types in a terminal, each followed by a space and its next word or flag ("agentes-runner doctor"). */
const CLI =
  "agentes-runner|npx?|bunx?|pip3?|brew|apt(?:-get)?|winget|loginctl|systemctl|journalctl|getent|curl|docker|sudo|xcodebuild|tailscale|hermes|codex|claude|gemini";
const GIT =
  "push|pull|clone|commit|config|status|log|checkout|fetch|merge|rebase|diff|add|init|remote|branch|switch|reset";

/**
 * A command, a path or a setting's name in words people read: a CLI with its next word, `git` with a subcommand
 * (never "git" alone, as in "a git repository"), a home or system path, a Windows `%VAR%`, an `ENV_NAME`.
 */
export const COMMAND = new RegExp(
  `(?<![\\w./-])(?:(?:${CLI}) [-a-z]|git (?:${GIT})\\b)|~\\/|\\/srv\\/|\\/etc\\/|%[A-Z]+%|\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b`,
);

/** What is already code: `spans` and `<code>…</code>` tags. */
const outsideCode = (text: string) => text.replace(/`[^`]*`/g, "").replace(/<code>.*?<\/code>/g, "");

/** A help page's code block, code already. */
const CODE_BLOCK = /\.blocks\.\d+\.code$/;

/** Keys whose command stays plain, each with its reason. */
export const PLAIN_COMMAND_ALLOWED: Readonly<Record<string, string>> = {
  "vault.field.keyNamePlaceholder": "an input's placeholder, which shows no markup",
  "scopes.github_git_write.label": "a permission's name, also joined into plain lists and approval sentences",
  "scopes.gitlab_git_write.label": "a permission's name, also joined into plain lists and approval sentences",
  "scopes.bitbucket_git_write.label": "a permission's name, also joined into plain lists and approval sentences",
  "scopes.git_git_write.label": "a permission's name, also joined into plain lists and approval sentences",
  "palette.changeModelKeywords": "search words, never shown",
  "palette.keysKeywords": "search words, never shown",
};

/** A string tree's leaves that show a command outside code, as "key: text", for one readable failure. */
export const uncodedCommands = (tree: unknown) =>
  leaves(tree)
    .filter((leaf): leaf is [string, string] => typeof leaf[1] === "string")
    .filter(
      ([key, text]) => !CODE_BLOCK.test(key) && !(key in PLAIN_COMMAND_ALLOWED) && COMMAND.test(outsideCode(text)),
    )
    .map(([key, text]) => `${key}: ${text}`);
