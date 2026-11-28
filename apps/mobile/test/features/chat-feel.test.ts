import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORBIT_LIGHT, ORBIT_RINGS } from "@agenteschat/ui/agent/orbit";
import { keepSameRows, sameItems } from "../../src/features/chat/logic";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
/** The text from `from` up to `to` (or the end). */
const between = (text: string, from: string, to?: string) => {
  const at = text.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(at, to ? text.indexOf(to, at + from.length) : undefined);
};

describe("swiping a message to answer it", () => {
  const swipe = src("features/chat/SwipeReply.tsx");

  test("the reply goes on letting go, armed or flicked past the line; crossing it only arms it, with its tap", () => {
    const update = between(swipe, "onUpdate: (e) => {", "onDeactivate:");
    expect(update).toContain("scheduleOnRN(tap);");
    expect(update).not.toContain("reply");
    // Pulled back under the line's lower mark, it is off again: a wobble at the line never flickers it.
    expect(update).toContain("} else if (armed.value && tx < UNARM) {");
    expect(swipe).toContain("const COMMIT = 52;");
    expect(swipe).toContain("const UNARM = 40;");
    const release = between(swipe, "onDeactivate: (e) => {", "const slide =");
    expect(release).toContain("const flicked = tx + Math.max(0, e.velocityX) * FLICK_S >= COMMIT;");
    expect(release).toContain("if (!e.canceled && (wasArmed || flicked)) scheduleOnRN(reply, wasArmed);");
  });

  test("off or on, the same views stand around the row: a message turning sent isn't drawn again", () => {
    expect(swipe).not.toContain("if (!enabled)");
    // One config for the row's life, `enabled` in it: a render (a touch's, which mounts the mark) never rebuilds it.
    expect(swipe).toMatch(/useMemo\(\(\): PanGestureConfig => \{[\s\S]*?return \{\s*enabled,/);
    expect(swipe).toContain("}, [enabled, onReply, reducedMotion, x, armed]);");
    expect(swipe).toContain("const pan = usePanGesture(config);");
    // The mark under the row mounts only once a finger lands on it.
    expect(swipe).toContain("{marked ? <ReplyMark x={x} armed={armed} /> : null}");
    const chat = chatScreenSource();
    expect(chat).toContain("<SwipeReply enabled={canReply && !m.local} onReply={reply}>");
    expect(chat).toMatch(/\{NATIVE_MENU \? \(?\s*<MessageMenuFor/);
    expect(chat).not.toContain("NATIVE_MENU && !m.local");
    // Its menu then holds what works before the server has it: no reactions, no empty palette.
    const menu = src("features/chat/MessageMenu.tsx");
    expect(menu).toContain("reactions={armed && !context.message.local ? QUICK_REACTIONS : NO_REACTIONS}");
    expect(menu).toContain("{reactions.length > 0 ? (");
    // Built once a finger lands on the row (or with a screen reader on), never for every row a scroll mounts.
    expect(menu).toContain("onArm={armed ? undefined : arm}");
    expect(menu).toContain(
      '{groups === null ? <NativeLinkPreviewAction identifier="building" title="" hidden onSelected={noop} /> : null}',
    );
    // A plain box around the row, never expo-router's Link: its native view takes `display: contents`, and in there the
    // row's frames went stale as its words changed size (a long message's bubble drew empty space under its words).
    expect(menu).toContain("<NativeLinkPreview previewActivationPath={undefined}>");
    expect(menu).not.toMatch(/<Link[\s.>]/);
  });
});

describe("the conversation's rows", () => {
  test("a receipt, a thread's link or the lit row redraws its own row, never every row on screen with its menu", () => {
    const chat = chatScreenSource();
    // Each message row is one memoized piece, handed what is its own and callbacks that keep their identity.
    expect(chat).toContain("const ChatMessage = memo(function ChatMessage({");
    expect(chat).toMatch(/const hands = useMemo<RowHands>\(\s*\(\) => \(\{ onReply, onMission, onRemind, onLongPress,/);
    expect(chat).toContain("lit={item.message.id === flashId}");
    expect(chat).toContain("markReceipt={item.message.id === markAt ? receipt : undefined}");
    expect(chat).toContain("lineReceipt={item.message.id === receiptId ? receipt : undefined}");
    // No callback or menu context made in the list's draw: each row builds its own, kept across redraws.
    expect(chat).not.toContain("onReply={() => onReply(item.message)}");
    expect(chat).toContain("const reply = useCallback(() => onReply(m), [onReply, m]);");
    expect(chat).toContain("const menu = useMemo<MessageActionsContext>(");
    // A row mounted again as it scrolls back plays nothing in again, its receipt's line included.
    expect(chat).toMatch(/<LayoutAnimationConfig skipEntering>\s*\{m\.author\.type === "agent"/);
  });

  test("someone typing or an agent's step redraws the screen, not the list: nothing it is handed is made anew", () => {
    const chat = chatScreenSource();
    expect(chat).toContain(
      "const ConversationList = memo(KeyboardAwareLegendList) as unknown as typeof KeyboardAwareLegendList;",
    );
    expect(chat).not.toContain("<KeyboardAwareLegendList");
    const props = between(chat, "<ConversationList", "/>");
    expect(props).toContain("scrollIndicatorInsets={listIndicator}");
    expect(props).toContain("onScrollBeginDrag={onDragStart}");
    expect(props).toContain("ListHeaderComponent={listHeader}");
    // No handler or object written in the list's props.
    expect(props).not.toMatch(/=\{\(\) =>|=\{\{/);
  });

  test("a row holding the same as before is the same object, and an unchanged list is the same array", () => {
    type Row = { key: string } & Record<string, unknown>;
    const m1 = { id: "1" };
    const m2 = { id: "2" };
    const first: Row = { key: "a", kind: "message", message: m1, grouped: false };
    const second: Row = { key: "b", kind: "message", message: m2, grouped: true };
    const prev: Row[] = [first, second];
    // Rebuilt with nothing changed: the very same array.
    expect(keepSameRows(prev, [{ ...first }, { ...second }])).toBe(prev);
    // One row changed, one added: the others stay the objects they were.
    const edited: Row = { ...second, message: { id: "2", body: "edited" } };
    const added: Row = { key: "c", kind: "wait", wait: {} };
    const kept = keepSameRows(prev, [{ ...first }, edited, added]);
    expect(kept[0]).toBe(first);
    expect(kept[1]).toBe(edited);
    expect(kept[2]).toBe(added);
    // A field gained is a change.
    expect(keepSameRows(prev, [{ ...first, newTurn: true }, second])[0]).not.toBe(first);
    const fresh = [edited];
    expect(keepSameRows([], fresh)).toBe(fresh);
  });

  test("the same items in the same order keep the earlier array", () => {
    const a = { runId: "a" };
    const b = { runId: "b" };
    const prev = [a, b];
    expect(sameItems(prev, [a, b])).toBe(prev);
    const moved = [b, a];
    expect(sameItems(prev, moved)).toBe(moved);
    const fresh = [a, { runId: "b" }];
    expect(sameItems(prev, fresh)).toBe(fresh);
  });

  test("run events rebuild only the live rows; the messages' rows and what reads them keep", () => {
    const chat = chatScreenSource();
    expect(chat).toContain("browsingRef.current = sameItems(browsingRef.current, browsingRuns(runs));");
    expect(chat).toContain(`const makingKey = makingNow.map((r) => \`\${r.runId}:\${r.agentId}\`).join(" ");`);
    expect(chat).toContain("const making = useMemo(() => makingNow, [makingKey]);");
    const messages = between(chat, "const messageRows = useMemo<Row[]>(() => {", "const liveRows");
    expect(messages).not.toContain("browsing");
    expect(messages).not.toContain("waits");
    // Nor the DM and channel lists, read again with each message: only the thread head's words and count, and the
    // consulted agents' words folded into their askers' quotes, kept until a fold changes (`relaysKey`).
    expect(messages).toContain(
      "}, [isThread, threadId, list, startedText, replyCount, superseded, timeLines, relays, t]);",
    );
    expect(chat).toContain("const relays = useMemo(() => relaysNow, [relaysKey]);");
    expect(chat).toContain("[browsing, held, making, waits],");
    expect(chat).toContain('() => messageRows.flatMap((r) => (r.kind === "message" ? [r.message] : [])),');
    expect(chat).toContain("shownRef.current = keepSameRows(shownRef.current, next);");
  });

  test("a new row rises in on the strong ease-out", () => {
    // The app's one rise (`RISE_IN`), also the voice take's line and bar.
    expect(chatScreenSource()).toContain("const ENTER = RISE_IN;");
    const entrances = src("ui/entrances.ts");
    expect(entrances).toContain("100: { opacity: 1, transform: [{ translateY: 0 }], easing: motion.easeOut },");
    expect(src("ui/theme.tsx")).toContain("easeOut: Easing.bezier(0.23, 1, 0.32, 1),");
  });
});

describe("older pages", () => {
  const chat = chatScreenSource();

  test("a page that didn't come is not the start: the row above the oldest message offers to try again", () => {
    expect(chat).toContain(".catch(() => setOlderFailed(true))");
    expect(chat).not.toContain(".catch(() => setOlderDone(true))");
    // The list's own asks stop after a failure (they come at every layout); the row's retry asks again.
    expect(chat).toContain("if (!olderFailed && !loadingOlder) fetchOlder();");
    expect(chat).toContain("<OlderRow loading={loadingOlder} failed={olderFailed} onRetry={fetchOlder} />");
    const row = between(chat, "function OlderRow(", "function UnseenLine(");
    expect(row).toContain("if (failed && !loading) return <RetryLine onRetry={onRetry} />;");
    expect(row).toContain(
      '<ActivityIndicator size="small" color={c.muted} accessibilityLabel={t("common.loadingMessages")} />',
    );
    // Waiting or loading, one height: a page starting to load never moves the conversation.
    expect(chat).toContain('older: { height: OLDER_ROW, alignItems: "center", justifyContent: "center" },');
  });

  test("going to a message reads the page around it at any distance; a failed read says so, a 404 says it's gone", () => {
    expect(chat).toContain(
      ".messages(orgId, channelId, { around: seek, limit: SEEK_PAGE, onCards: cardsInto(qc, orgId) })",
    );
    expect(chat).toContain("const gone = error === undefined || (error instanceof ApiError && error.status === 404);");
    expect(chat).toContain('toast({ title: gone ? t("channel.jumpMissing") : t("common.loadFailed"), icon: "x" });');
    // In a thread, one of the conversation outside it (a long work's report) opens in the conversation, at it.
    expect(chat).not.toContain("if (isThread || (around?.id === seek && around.done))");
    expect(chat).toContain(".messages(orgId, channelId, { around: seek, limit: 1 })");
    expect(chat).toContain("router.push(chatHref(channelId, null, seek));");
    // Away from the latest page: newer pages as the person scrolls down, never pinned to that end.
    expect(chat).toContain("onEndReached={gap ? loadNewer : undefined}");
    expect(chat).toContain("maintainScrollAtEnd={readHold || gap ? false : GLIDE}");
  });
});

describe('the "New" line', () => {
  test("it comes in the same frame as the first new row and stays put until the person leaves the screen", () => {
    const chat = chatScreenSource();
    // Derived in the render that brings the row (put a render later, it pushed the row down under the person's eyes).
    expect(chat).toContain("const dividerKey = placedDivider ?? unseen.firstKey;");
    expect(chat).toContain("if (!focused) setPlacedDivider(null);");
    // Never faded or taken out while the conversation shows: a row going away moved every message under it.
    expect(chat).not.toContain("DIVIDER_FADE_MS");
    expect(between(chat, "function UnseenLine()", "\n}\n")).not.toContain("withTiming");
  });

  test("the older pages' row keeps its room once the start is reached", () => {
    const chat = chatScreenSource();
    expect(chat).toContain("<View style={styles.older} />");
  });
});

describe("sheets that open the next thing", () => {
  test("stack the next step over the sheet, or wait for it to be gone (`sheet.close` says when), never a guessed time", () => {
    const chat = chatScreenSource();
    expect(chat).not.toContain("SHEET_LEAVE_MS");
    expect(chat).not.toMatch(/setTimeout\(\(\) => open(NewMission|Remind)\(\), \d+\)/);
    // The message the last conversation opened at goes with it (`m`): the params merge.
    expect(chat).toContain(
      'else sheet.close(() => router.setParams({ channelId: id, thread: "", handoff: "", m: "" }));',
    );
    // The "+": the GIFs, a reminder and a mission's summary stack over it at once (a flick down goes back to it); the
    // camera, the library and the files picker wait for it to be gone.
    const plus = between(chat, "const onPlus = async (pick: PlusPick) => {", 'case "camera": {');
    expect(plus).toMatch(/case "media":\s*openMedia\(\);\s*return;\s*case "remind":\s*openRemind\(\);\s*return;/);
    expect(plus).toContain("await new Promise<void>((done) => sheet.close(done));");
    expect(chat).toContain("const openMedia = () =>\n    sheet.push(");
  });
});

describe("the composer", () => {
  const composer = src("ui/Composer.tsx");
  const chat = chatScreenSource();

  test("the picker and the pills float above the measured box: typing never moves the conversation", () => {
    expect(composer).toContain("{float ? null : floating}");
    expect(composer).toContain("float?.set(floating);");
    expect(composer).toContain("useLayoutEffect(() => () => float?.set(null), [float]);");
    // In the dock, after the button to the latest and before the box whose height insets the list.
    const dock = chat.indexOf("style={styles.composerDock}");
    const button = chat.indexOf("<ToLatest unseen={unseen} onPress={toEnd} />", dock);
    const float = chat.indexOf("<ComposerFloat slot={composerFloat} />", dock);
    expect(float).toBeGreaterThan(button);
    expect(chat.indexOf("ref={composerRef}", dock)).toBeGreaterThan(float);
    expect(chat).toContain("float={composerFloat}");
    // No suggestion pills over the conversation: the list's end inset is the box (and what the keyboard library's two
    // paths disagree on, `useListEnd`).
    expect(chat).not.toContain("composerSuggestions");
    expect(chat).not.toContain("PILLS_ROOM");
    expect(chat).toContain("boxHeight.set(height);");
    expect(chat).toContain("contentInsetEndAdjustment={listEnd}");
  });

  test("the send button comes in from 0.85 on an ease-out with no overshoot, and leaves the same way", () => {
    expect(composer).not.toMatch(/\bZoom(In|Out)\b/);
    expect(composer).toContain("const SEND_FROM = 0.85;");
    expect(composer).toContain("initialValues: { opacity: 0, transform: [{ scale: SEND_FROM }] },");
    expect(composer).toContain(
      "transform: [{ scale: withTiming(SEND_FROM, { duration: SEND_MS, easing: EASE_OUT }) }],",
    );
    // Reduced motion: the fade alone.
    expect(composer).toContain("entering={reducedMotion ? SEND_FADE_IN : SEND_IN}");
    expect(composer).toContain("exiting={reducedMotion ? SEND_FADE_OUT : SEND_OUT}");
  });

  test("the hold ring waits past a tap before it shows, and still closes when the hold lands", () => {
    expect(composer).toContain("const RING_DELAY_MS = 120;");
    expect(composer).toMatch(
      /ring\.value = withDelay\(\s*RING_DELAY_MS,\s*withTiming\(1, \{ duration: HOLD_SEND_MS - RING_DELAY_MS, easing: Easing\.linear \}\),\s*\);/,
    );
    // The track shows only with the ring.
    expect(composer).toContain("const trackOpacity = useDerivedValue(() => (ring.value > 0.001 ? 1 : 0));");
  });
});

describe("the working line", () => {
  const lines = src("features/chat/LiveRows.tsx");

  test("its faces come in from 0.9, never from nothing", () => {
    expect(lines).not.toContain("ZoomIn");
    const pop = between(lines, "const FACE_POP: EntryExitAnimationFunction", "/**");
    expect(pop).toContain("initialValues: { opacity: 0, transform: [{ scale: 0.9 }] },");
  });

  test("whoever does the work leads with its orbit (the web's), what it did so far under the words, paced", () => {
    // The agent at work, or the one a question or hand-off went to; the stack's small faces are the others, never a
    // face twice.
    expect(lines).toContain("const worker = asking ? { id: asking.to, name: asking.toName } : lead;");
    expect(lines).toContain("<OrbitFace color={agentLook(dir.agentById.get(worker.id)).color} size={ORBIT_FACE}>");
    expect(lines).toContain("const faces = barFaces(entries).filter((e) => e !== lead);");
    expect(lines).toContain("usePacedTrail(trailRun ? workTrail(t, trailRun, i18n.language) : NO_TRAIL)");
    // The folded steps in words ("3 earlier steps"), never a bare "+3".
    expect(lines).toContain('{t("chat.trail.earlier", { count: trail.earlier })}');
    expect(lines).not.toContain("+{trail.earlier}");
    const orbit = src("agent/OrbitFace.tsx");
    // The web's rings, light and colours, drawn on the UI thread from a clock that runs only while it moves: still
    // with Reduce Motion and on a screen that isn't showing.
    expect(orbit).toContain('} from "@agenteschat/ui/agent/orbit";');
    expect(orbit).toContain("const clock = useDrawingClock(!reduced && !paused);");
    expect(orbit).not.toMatch(/requestAnimationFrame|setInterval/);
    // The rings themselves turn round the face on that clock (the web's `ac-orbit__roll`), their light riding them.
    // With Reduce Motion each rests at its tilt whatever the clock reached before the setting came on.
    expect(orbit).toContain("{ rotate: still ? (ring.tilt * Math.PI) / 180 : ringAngle(ring, roll, clock.value) },");
    expect(orbit).toContain("return ((ring.tilt + (360 * (ms / 1000 + roll)) / ring.spin) * Math.PI) / 180;");
    expect(orbit).toContain("still={reduced}");
    expect(orbit).not.toContain("{ rotate: (ring.tilt * Math.PI) / 180 }]");
  });

  test("a ring turned upright is never clipped or into a name: the line and the pinned strip have room", () => {
    // How far past the face a ring stands upright, in faces: its radius and the dot at its head.
    const reach = Math.max(...ORBIT_RINGS.map((r) => r.r / 2)) - 0.5 + ORBIT_LIGHT.dot / 100;
    // The working line clips nothing (its 24-point face in a 28-point line).
    const pill = between(lines, "  pill: {", "},");
    expect(pill).not.toContain("overflow");
    // The pinned strip scrolls (it clips at its top) and its names sit under the faces.
    const strip = src("features/chats/PinnedStrip.tsx");
    const num = (re: RegExp) => Number(strip.match(re)?.[1]);
    const face = num(/const FACE = (\d+);/) - 2;
    const above = num(/strip: \{[^}]*paddingTop: (\d+)/) + num(/itemIn: \{[^}]*paddingVertical: (\d+)/);
    expect(above).toBeGreaterThanOrEqual(reach * face);
    // Under the face: the gap and the footnote's room over its capitals (18-point line, 13-point text) clear the tip.
    expect(num(/itemIn: \{[^}]*gap: (\d+)/) + 4).toBeGreaterThanOrEqual(reach * face);
  });

  test('"View" reaches 44 points', () => {
    expect(lines).toContain(
      "hitSlop={{ top: (TOUCH - SEE_LINE) / 2, bottom: (TOUCH - SEE_LINE) / 2, left: 12, right: 12 }}",
    );
    expect(lines).toContain("const SEE_LINE = 16;");
  });
});

describe("small targets", () => {
  test("the reply bar's × and the quote's line reach 44 points", () => {
    const quote = src("features/chat/QuoteLine.tsx");
    expect(quote).toContain("hitSlop={(TOUCH - X) / 2}");
    expect(quote).toContain("hitSlop={{ top: (TOUCH - LINE) / 2, bottom: (TOUCH - LINE) / 2 }}");
    expect(quote).toContain("const LINE = 20;");
    expect(quote).toContain("const X = 16;");
  });
});

describe("the header's pill", () => {
  const pill = src("features/chat/HeaderPill.tsx");

  test("while an agent works it holds the room's width: its steps roll the line in and never spring the width", () => {
    expect(pill).toMatch(
      /: closed\s*\? HEIGHT\s*: working\s*\? room\s*: Math\.min\(room, Math\.max\(MIN_WIDTH, chrome \+ words\)\);/,
    );
    // No breathing, and the step never slides to show its end.
    expect(pill).not.toMatch(/breath|BREATH|withRepeat/);
    expect(pill).toContain("still={working}");
    expect(pill).toContain("if (!long || still) return;");
    // The line still rolls in over the last.
    expect(pill).toContain("entering: rollIn, exiting: rollOut");
  });

  test("a hold buzzes once: its own firm tap; PressScale's light one comes only with a press that lands", () => {
    const hold = between(pill, "onLongPress: () => {", "}");
    expect(hold).toContain("haptics.medium();");
    const press = src("ui/PressScale.tsx");
    expect(press).toContain("if (haptic && !disabled) haptics.light();");
    expect(between(press, "onPressIn={(e) => {", "}}")).not.toContain("haptics");
  });
});

describe("an empty conversation's greeting and the keyboard", () => {
  test("follows the keys with a translate and takes their room once they settle: no layout per frame", () => {
    const room = src("features/chat/keyboard-room.ts");
    expect(room).toContain("const room = useAnimatedStyle(() => ({ paddingTop: settled.get() }));");
    expect(room).toContain("transform: [{ translateY: -Math.max(0, -keyboard.height.get() - lift) }],");
    expect(room).toContain("settled.set(Math.max(0, e.height - lift));");
    expect(room).toContain("if (e.height === 0) settled.set(0);");
    for (const file of ["features/chat/FirstDay.tsx", "features/chat/ChannelHello.tsx"]) {
      const s = src(file);
      expect({ file, room: s.includes("const above = useKeyboardRoom(keyboardLift);") }).toEqual({ file, room: true });
      expect({ file, spread: s.includes("style={[styles.grow, ...above]}") }).toEqual({ file, spread: true });
      expect({ file, padding: /paddingBottom: Math\.max\(0, -keyboard/.test(s) }).toEqual({ file, padding: false });
    }
  });
});

describe("a table wider than its message", () => {
  test("its scroll never redraws it: the standing column, its edge and the fade follow the scroll on the UI thread", () => {
    const spans = src("features/chat/MessageSpans.tsx");
    expect(spans).not.toContain("setX(");
    expect(spans).toContain("const TableScroller = Animated.createAnimatedComponent(GestureScrollView);");
    expect(spans).toContain("const onScroll = useAnimatedScrollHandler({");
    expect(spans).toContain("onScroll={onScroll}");
    expect(spans).toContain("transform: [{ translateX: Math.max(0, x.value) }],");
    expect(spans).toContain("opacity: Math.min(1, Math.max(0, (total - frame - x.value) / TABLE_FADE)),");
  });
});

describe("dragging sideways in a message", () => {
  test("a voice message's wave and a block's slider wait for a clear sideways move: the list keeps vertical ones", () => {
    for (const file of ["features/voice/VoiceMessage.tsx", "features/blocks/SpecBlock.tsx"]) {
      const s = src(file);
      expect({ file, x: s.includes("activeOffsetX: [-10, 10],") }).toEqual({ file, x: true });
      expect({ file, y: s.includes("failOffsetY: [-6, 6],") }).toEqual({ file, y: true });
    }
  });

  test("the slider works out its step on the UI thread and tells the screen only a new one, with 44 points to touch", () => {
    const spec = src("features/blocks/SpecBlock.tsx");
    const follow = between(spec, "const follow = (px: number) => {", "const pan =");
    expect(follow).toContain("const next = stepAt(to, min, max, step);");
    expect(follow).toContain("if (next === said.value) return;");
    expect(follow).toContain("scheduleOnRN(land, next);");
    expect(spec).toContain("const SLIDER_SLOP = { top: (TOUCH - SLIDER_H) / 2, bottom: (TOUCH - SLIDER_H) / 2 };");
    expect(spec).toContain("hitSlop={SLIDER_SLOP}");
  });
});

describe("a voice message's row", () => {
  const row = src("features/voice/VoiceMessage.tsx");

  test("a scrubbing finger owns the handle: the player's ticks don't move it, and it seeks where the finger let go", () => {
    expect(row).toContain("if (id !== clipId || scrubbing.value) return;");
    const pan = between(row, "const pan = usePanGesture({", "const tap =");
    expect(pan).toContain("scrubbing.value = true;");
    expect(pan).toContain("const at = width > 0 ? waveAt(e.x, width, BAR_HANDLE) : progress.value;");
    expect(pan).toContain("scheduleOnRN(endScrub, at);");
  });

  test("it plays at once with its button spinning; only a failed player asks the server whether the audio is gone", () => {
    expect(row).toContain("const starting = useSyncExternalStore(subscribePlayback, startingId) === clipId;");
    expect(row).toContain('<ActivityIndicator size="small" color={c.bg} />');
    const toggle = between(row, "const toggle = () => {", "const seek =");
    expect(toggle.indexOf("isGone?.()")).toBeGreaterThan(toggle.indexOf("const failed = () => {"));
    expect(row).toContain("isGone={() => voiceAudioGone(url, authedFetch as typeof fetch)}");
    expect(toggle).toContain("onError: failed,");
    expect(toggle).toContain("}).catch(failed);");
    // Where it stands is the playback module's: a row drawn again mid-play shows it.
    expect(row).toContain("const progress = useSharedValue(placeOf(clipId));");
    expect(row).not.toContain("const positions = new Map");
  });
});

describe("lists that didn't load", () => {
  test("two agents' conversation and the pins say so with the way to try again", () => {
    const consult = src("features/chat/ConsultationScreen.tsx");
    expect(consult).toContain("<LoadFailed onRetry={() => void query.refetch()} />");
    expect(consult).not.toContain('query.isError ? t("common.loadFailed")');
    const pins = src("features/chat/PinsSheet.tsx");
    expect(pins).toContain("<LoadFailed onRetry={() => void pins.refetch()} />");
  });
});
