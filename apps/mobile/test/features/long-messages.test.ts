import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("long messages on the phone", () => {
  test("a tall message clips by the rule the web uses, and Ver mais opens it in place for good, kept by the screen", () => {
    const clip = src("features/chat/ClippedMessage.tsx");
    expect(clip).toContain(
      'import { clippedHeight, LONG_MESSAGE, shownWhole } from "@agenteschat/client/lib/message-length"',
    );
    expect(clip).toContain("const cut = clippedHeight(height);");
    // In place: no sheet, no copy of its own (Copiar stays in the message's menu), and nothing folds it back.
    expect(clip).not.toContain("useSheetIfAny");
    expect(clip).not.toContain("copyText");
    expect(clip).not.toMatch(/setTapped\((false|!)/);
    expect(src("features/chat/sheets.tsx")).toContain('label: t("mobile.chat.copy")');
    // The screen keeps which are open (its list unmounts rows off screen), and opening one stops it following the end.
    expect(clip).toContain("const open = fullMessages || tapped || Boolean(screen?.has(id)) || shownWhole.has(id);");
    expect(clip).toContain("screen?.open(id);");
    const screen = chatScreenSource();
    expect(screen).toContain("<OpenedMessagesContext.Provider value={openedMessages}>");
    // Kept for the session too, the web's set: a screen opened again starts with them.
    expect(screen).toMatch(
      /open: \(id\) => \{\s*shownWhole\.add\(id\);\s*setOpened\(\(s\) => new Set\(s\)\.add\(id\)\);\s*if \(atEndRef\.current\) setReadHold\(true\);/,
    );
    expect(screen).toContain("useState<ReadonlySet<string>>(() => new Set(shownWhole))");
    // It opens at once, never with a layout transition: inside the list an animated height left the words' frame at
    // the fold under a bubble already as tall as the whole words. The reader's screen reader goes to the words.
    expect(clip).not.toContain("layout=");
    expect(clip).not.toContain("<Animated.View");
    expect(clip).toContain('AccessibilityInfo.sendAccessibilityEvent(words.current, "focus")');
    // As on the web: the words fade into what is behind them, and Ver mais sits on the fade's clear end.
    expect(clip).toContain("locations={[0, 1 - CLEAR / FADE, 1]}");
    expect(clip).toContain("shows !== null && styles.overFade");
    // A fade, never an ellipsis: no line count cuts the words.
    expect(clip).not.toContain("numberOfLines");
    const row = src("features/chat/MessageRow.tsx");
    expect(row.match(/<ClippedMessage\s/g)?.length).toBe(2);
    // Opened, its row mounts again at its whole height, no entrance played again: grown in place, the bubble's frame
    // stayed taller than its words, an empty block under the last line.
    expect(row).toContain("const opened = useContext(OpenedMessagesContext)?.has(props.message.id) === true;");
    expect(row).toContain('<LayoutAnimationConfig key={opened ? "opened" : "row"} skipEntering>');
    expect(clip).toContain("focusOnOpen = id;");
  });

  test("the newest message, the answer to the reader's latest and a mention of them show whole, as on the web", () => {
    const clip = src("features/chat/ClippedMessage.tsx");
    const screen = chatScreenSource();
    expect(screen).toContain("const ids = answerIds(messages);");
    expect(screen).toContain("for (const r of scrollRows) if (r.mentionsMe && r.id) ids.add(r.id);");
    // Shown whole once, it stays whole as newer messages arrive; an agent's message folded to its lead is not one.
    expect(clip).toContain("if (lead == null && screen?.answer(id)) shownWhole.add(id);");
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
    const screen = chatScreenSource();
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
    expect(chatScreenSource()).toContain('new File(dir, t("channel.tooLong.fileName"))');
  });
});
