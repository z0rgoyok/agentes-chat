import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));

describe("the conversation's looping marks run on the UI thread", () => {
  test("the typing dots and the recording bars are CSS loops, not a render per frame", () => {
    const rows = src("features/chat/LiveRows.tsx");
    // A React state ticking ~25 times a second re-rendered the working line while anyone typed.
    expect(rows).not.toContain("useFrameTime");
    expect(rows).toContain("const BAR_ROUND = css.keyframes({");
    expect(rows).toContain("const DOT_ROUND = css.keyframes({");
    const bars = between(rows, "function RecordingBars(", "function TypingDots(");
    expect(bars).toContain('loopStyle(BAR_ROUND, MARK_ROUND_MS, "linear", trailing(i, 200), paused)');
    expect(bars).toContain("const paused = useLivePaused();");
    const dots = rows.slice(rows.indexOf("function TypingDots("));
    expect(dots).toContain('loopStyle(DOT_ROUND, MARK_ROUND_MS, "linear", trailing(i, 150), paused)');
    // Every mark starts at once, already into its round: none waits still for its turn at mount.
    expect(rows).toContain("const trailing = (i: number, lag: number) => i * lag - MARK_ROUND_MS;");
  });

  test("the wait mark breathes with the app's other breathing marks, and holds off screen", () => {
    const mark = src("features/chat/WaitMark.tsx");
    expect(mark).not.toContain("withRepeat");
    expect(mark).toContain("const BREATH = css.keyframes(breathRound());");
    expect(mark).toContain("loopStyle(BREATH, BREATH_MS, SINE, breathDelay(startedAt), paused)");
    expect(mark).toContain("const breathing = !reduced && !still;");
  });
});

describe("two agents' conversation", () => {
  test("one sheet surface, the messages' skeleton while it loads, an empty state when it isn't there", () => {
    const screen = src("features/chat/ConsultationScreen.tsx");
    // Two nested surfaces applied the sheet's colors twice (the dark sheet took its cards' tone).
    expect(screen.split("<SheetSurface>").length - 1).toBe(1);
    expect(screen).not.toContain("ActivityIndicator");
    expect(screen).toContain("<ChatSkeleton look={look} top={0} bottom={0} />");
    expect(screen).toContain('<EmptyState size="inline" title={t("chat.consultPanel.missing")} />');
    // At the sides every screen and sheet keeps.
    expect(screen).toContain("pad: { paddingHorizontal: SCREEN_X },");
    expect(screen).toMatch(/foot: \{[^}]*paddingHorizontal: SCREEN_X,/);
    expect(screen).toMatch(/head: \{ paddingHorizontal: SHEET_X, paddingTop: 24,/);
  });
});

describe("buttons in the rows show what they do", () => {
  test("Continue alone is the kit's small button, with its spinner while it asks", () => {
    const row = src("features/chat/MessageRow.tsx");
    const alone = between(row, "if (fallback === null) {", "const agentName = dir.nameOf(m.author)");
    expect(alone).toContain("<Button");
    expect(alone).toContain("loading={busy}");
    expect(alone).toContain("if (continued || !(open || busy)) return null;");
    expect(alone).not.toContain("PressScale");
    expect(row).not.toContain("continueIn");
  });

  test("the returns' sheet says a failed load with the way to try again, and loads in the rows' shape", () => {
    const sheet = src("features/chat/Returns.tsx");
    const body = sheet.slice(sheet.indexOf("export function ReturnsSheet("));
    expect(body).toContain("<SkeletonList rows={2} />");
    expect(body).toContain("<LoadFailed onRetry={() => void query.refetch()} />");
    expect(body).not.toContain('t("mobile.app.failed")');
  });

  test("the report offer says why when the server refuses a choice", () => {
    const offer = src("features/chat/FeedbackOffer.tsx");
    expect(offer).toContain('decide.mutate("send", { onError: failed })');
    expect(offer).toContain('decide.mutate("dismiss", { onError: failed })');
    expect(offer).toContain("prefs.mutate({ feedbackAuto: !always }, { onError: failed })");
    expect(offer).toContain('toast({ title: errorText(t, error), icon: "x" })');
  });

  test("the work line's refusals are failures, and a blocked task is words in the state's color", () => {
    const line = src("features/chat/WorkLine.tsx");
    expect(line).toContain('toast({ title: t("work.stopFailed"), icon: "x" })');
    expect(line).toContain('toast({ title: t("work.shareFailed"), icon: "x" })');
    expect(line).not.toContain("warnSoft");
    expect(line).toContain('blocked: { fontWeight: "600" },');
  });

  test("letting someone talk to an agent can't be tapped twice while it saves", () => {
    const reach = src("features/chat/ReachLines.tsx");
    const allow = between(reach, "export function AllowTalkAction(", "export function LetMeTalkButton(");
    expect(allow).toContain("disabled={save.busy || save.done}");
  });
});

describe("voice", () => {
  test("the speed chip and the microphone take a finger's 44", () => {
    const player = src("features/voice/VoiceMessage.tsx");
    expect(player).toContain("hitSlop={(TOUCH - SPEED_H) / 2}");
    expect(player).toContain("accessibilityValue={{ text: `${speedFormat.format(rate)}×` }}");
    const composer = src("features/voice/useVoiceComposer.tsx");
    expect(composer).toContain("const MIC_SLOP = (TOUCH - MIC) / 2;");
    expect(composer.split("hitSlop: MIC_SLOP,").length - 1).toBe(2);
  });

  test("deleting a take is the person's own act: a fold, a haptic and a sound, no toast; a screen reader hears it", () => {
    const take = src("features/voice/useVoiceTake.ts");
    expect(take).not.toContain('toast({ title: t("voice.deleted")');
    expect(take).toContain('AccessibilityInfo.announceForAccessibility(t("voice.deleted"));');
  });
});

test("the rows' and voice's comments name no other product", () => {
  const files = [
    "features/chat/DatePill.tsx",
    "features/chat/LiveRows.tsx",
    "features/chat/MessageRow.tsx",
    "features/voice/logic.ts",
    "features/voice/VoiceMessage.tsx",
  ];
  for (const f of files) expect(src(f)).not.toMatch(/WhatsApp|Telegram|iMessage|Slack|Discord/);
});
