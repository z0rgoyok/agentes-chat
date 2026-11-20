import { isApple } from "@agenteschat/ui";
import type { TFunction } from "i18next";

/** The document's keys in "Keyboard shortcuts" (ADR 0200): what `docKeymap` binds, as the platform writes it. */
export function documentShortcuts(t: TFunction, mod: string): [string, string[]][] {
  const alt = isApple() ? "⌥" : "Alt";
  return [
    [t("live.doc.bold"), [mod, "B"]],
    [t("live.doc.italic"), [mod, "I"]],
    [t("live.doc.underline"), [mod, "U"]],
    [t("live.doc.keys.strike"), [mod, "⇧", "X"]],
    [t("live.doc.keys.code"), [mod, "E"]],
    [t("live.doc.keys.link"), [mod, "K"]],
    [t("live.doc.keys.text"), [mod, alt, "0"]],
    [t("live.doc.keys.heading"), [mod, alt, "1–3"]],
    [t("live.doc.keys.bulletList"), [mod, "⇧", "8"]],
    [t("live.doc.keys.numberedList"), [mod, "⇧", "7"]],
    [t("live.doc.keys.lineBreak"), ["⇧", "↵"]],
    [t("live.doc.keys.nextCell"), ["Tab"]],
  ];
}
