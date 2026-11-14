import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("long messages on the phone", () => {
  test("a tall message clips by the rule the web uses, and Ver mais opens it in place for good, kept by the screen", () => {
    const clip = src("features/chat/ClippedMessage.tsx");
    expect(clip).toContain('import { clippedHeight } from "@agenteschat/client/lib/message-length"');
    expect(clip).toContain("const cut = clippedHeight(height);");
    // In place: no sheet, no copy of its own (Copiar stays in the message's menu), and nothing folds it back.
    expect(clip).not.toContain("useSheetIfAny");
    expect(clip).not.toContain("copyText");
    expect(clip).not.toMatch(/setTapped\((false|!)/);
    expect(src("features/chat/sheets.tsx")).toContain('label: t("mobile.chat.copy")');
    // The screen keeps which are open (its list unmounts rows off screen), and opening one stops it following the end.
    expect(clip).toContain("const open = tapped || Boolean(screen?.has(id));");
    expect(clip).toContain("screen?.open(id);");
    const screen = src("features/chat/ChatScreen.tsx");
    expect(screen).toContain("<OpenedMessagesContext.Provider value={openedMessages}>");
    expect(screen).toMatch(
      /open: \(id\) => \{\s*setOpened\(\(s\) => new Set\(s\)\.add\(id\)\);\s*if \(atEndRef\.current\) setReadHold\(true\);/,
    );
    // It grows down from the fold, at once with Reduce Motion, and the reader's screen reader goes to the words.
    expect(clip).toContain("layout={tapped && !reduced ? REVEAL : undefined}");
    expect(clip).toContain('AccessibilityInfo.sendAccessibilityEvent(words.current, "focus")');
    // A fade, never an ellipsis: no line count cuts the words.
    expect(clip).not.toContain("numberOfLines");
    const row = src("features/chat/MessageRow.tsx");
    expect(row.match(/<ClippedMessage /g)?.length).toBe(2);
  });

  test("an agent's long message to another agent opens in place too: no push to its thread", () => {
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain("lead={talk ? saying(talk.lead) : undefined}");
    expect(row).not.toContain("chat.talk");
    expect(row).not.toContain("chatHref(m.channelId, m.threadId ?? m.id)");
  });

  test("every other fold that opens in place says Ver mais and never folds back", () => {
    for (const file of [
      "features/chat/FoldedBody.tsx",
      "features/approvals/parts.tsx",
      "features/blocks/LiveBlock.tsx",
      "features/blocks/SpecBlock.tsx",
    ]) {
      const s = src(file);
      expect({ file, more: s.includes('t("channel.long.more")') }).toEqual({ file, more: true });
      expect({ file, less: /folded\.(more|less)|approval\.email\.(more|less)|blocks\.show(All|Less)/.test(s) }).toEqual(
        {
          file,
          less: false,
        },
      );
    }
  });

  test("a failed message says why and offers one way out; the toast says the cause too", () => {
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain("{sendFailureText(t, m.sendFailure, i18n.language)}");
    expect(row).toContain('t(sendNeedsEdit(m.sendFailure) ? "channel.editSend" : "channel.retrySend")');
    const screen = src("features/chat/ChatScreen.tsx");
    expect(screen).toContain('if (!waits) toast({ title: errorText(t, error, i18n.language), icon: "x" });');
    expect(screen).toMatch(/else if \(sendNeedsEdit\(m\.sendFailure\)\) \{[\s\S]*?setCaptionBack\(\{ text: m\.body/);
    // The row leaves the list, so its text must reach the field even when something is being typed there.
    expect(screen).toContain("setCaptionBack({ text: m.body, at: Date.now(), join: true });");
    expect(src("ui/Composer.tsx")).toContain("prefill.join ? joinDrafts(handed, current)");
  });

  test("the field holds a draft past the limit, says the sizes and offers it as a file", () => {
    const composer = src("ui/Composer.tsx");
    expect(composer).toContain("const tooLong = tooLongToSend(text);");
    expect(composer).toContain("if ((!value && !sendEmpty) || tooLong) return;");
    expect(composer).toContain("{tooLongText(t, i18n.language, text.trim().length)}");
    expect(composer).toContain('t("channel.tooLong.asFile")');
    expect(src("features/chat/ChatScreen.tsx")).toContain('new File(dir, t("channel.tooLong.fileName"))');
  });
});
