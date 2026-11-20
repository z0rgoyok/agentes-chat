import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composerLift, listKeyboardRoom } from "../../src/features/chat/dock-height";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("the dock grows at the conversation's end (a request out of view, the reply bar): the conversation keeps ending above it", () => {
  const chat = chatScreenSource();
  expect(chat).toContain("followingEnd.current = atEnd && !readHold;");
  // One place does it: two frames on, only a list the grown dock left short (still scrolling down) goes on to the end.
  expect(chat).toMatch(
    /if \(followsEnd\(\) && state && state\.distanceFromEnd > END_SLACK\)\s*void listRef\.current\?\.scrollToEnd\(\{ animated: true \}\);/,
  );
  // Following the end is the list's own follow too: a message just sent is still scrolling down (the screen's `atEnd`
  // is false then) when the agent's working line grows the dock, and it must not stay under it.
  expect(chat).toContain("return !!state && (state.isFollowingEnd || state.isAtEnd);");
  // While a send glides, the list's own follow takes the grown dock into the same motion.
  expect(chat).toContain("if (grew && followsEnd() && !gliding.current)");
  // The second scroll that ran over the list's own shift is gone.
  expect(chat).not.toContain("boxHeightRef");
});

test("the dock's height redraws only what is drawn from it, never the whole conversation", () => {
  const chat = chatScreenSource();
  // Held outside the screen's state: a field growing a line, the working line coming or going drew the whole screen.
  expect(chat).not.toContain("setComposerHeight");
  expect(chat).toContain("const [dock] = useState(createDockHeight);");
  expect(chat).toMatch(/boxHeight\.set\(height\);[\s\S]{0,200}dock\.set\(height\);\s*watchList\(\);/);
  // Read where it is drawn: the keyboard's gesture area, an empty conversation's greeting, the skeleton.
  expect(chat).toContain("<DockGestureArea dock={dock} lift={lift}>");
  expect(chat.match(/<DockRoom dock=\{dock\}>/g)).toHaveLength(2);
  expect(chat).toContain(
    "const useDockHeight = (dock: DockHeight) => useSyncExternalStore(dock.subscribe, dock.get, dock.get);",
  );
});

test("above the conversation's end, the dock's height and the keyboard move nothing", () => {
  const chat = chatScreenSource();
  // The library's default moved the words being read each time an agent started or finished (the dock's height).
  expect(chat).toContain('keyboardLiftBehavior="whenAtEnd"');
});

test("a pushed screen's large title is the system's on iOS, over a scroll view that is the screen's first child", () => {
  const pushed = src("features/shared/PushedLargeTitle.tsx");
  expect(pushed).toContain('Platform.OS === "ios" ? <SystemLargeTitle {...props} /> : <DrawnLargeTitle {...props} />');
  expect(pushed).toContain('contentInsetAdjustmentBehavior="automatic"');
  const header = src("features/shared/parts.tsx");
  expect(header).toContain("...(IOS ? { headerLargeTitleEnabled: largeTitle } : null),");
  expect(header).toContain("headerLargeTitleShadowVisible: false,");
});

test("the dock rides the keyboard library's values alone: nothing rewrites them from a notification's height", () => {
  const chat = chatScreenSource();
  // On iOS 26 and later a notification's height can be off by the suggestion row (40 points): rewritten from one,
  // the dock floated that much over the keys once the row left after a message was sent.
  expect(chat).not.toMatch(/keyboardAt\.(height|progress)\.(value =|set\()/);
  expect(chat).not.toContain("useKeyboardTruth");
  expect(chat).not.toContain("Keyboard.metrics()");
  expect(chat).not.toContain("KeyboardController.state()");
  expect(chat).toContain("<KeyboardStickyView offset={{ opened: lift }}");
  // The list ends where the dock starts (`useListEnd`); the agent's face and a background's band size to the box.
  expect(chat).toContain("useListEnd({ keyboard: keyboardAt, box: boxHeight, lift, freeze })");
  expect(chat).toContain("contentInsetEndAdjustment={listEnd}");
  // A drag holds the list's room while the keys follow the finger.
  expect(chat).toMatch(
    /showDay\(\);\s*\/\/[^\n]*\n\s*keyboardDragStarted\(\);\s*\}, \[showDay, still, keyboardDragStarted, dragging\]\);/,
  );
  expect(chat).toMatch(/hideDay\(\);\s*keyboardDragSettled\(\);/);
});

test("the list follows the dock when the keys' top moves with no notification, and rests with it once they are gone", () => {
  const end = src("features/chat/list-end.ts");
  // A move the system announced: both take its height, no gap.
  expect(end).toMatch(/room\.set\(listKeyboardRoom\(e\.height, target\.get\(\), lift\)\);\s*gap\.set\(0\);/);
  // The layout guide's reading with no finger on the list: the gap between where the dock rides and the list's room.
  expect(end).toMatch(
    /if \(dragging\.get\(\)\) \{\s*keysDragged\.set\(true\);\s*return;\s*\}[\s\S]{0,200}gap\.set\(composerLift\(-e\.height, e\.progress, lift\) - room\.get\(\)\);/,
  );
  expect(end).toMatch(
    /\(\) => box\.get\(\) \+ gap\.get\(\),\s*\(next, previous\) => \{\s*end\.set\(previous === null \? next : withTiming\(next, END_FOLLOW\)\);/,
  );
  // The system saying the keyboard is gone puts the dock down (zeros only), unless it comes back at once.
  expect(end).toMatch(/if \(back\) return;\s*if \(keyboard\.height\.get\(\) !== 0\) keyboard\.height\.set\(0\);/);
  expect(end).not.toMatch(/keyboard\.height\.set\((?!0\))/);
  expect(end).toMatch(/useEffect\(\(\) => \{\s*if \(!IOS\) return;/);
});

test("the dock's lift and the list's keyboard room agree for every reading of the same keyboard", () => {
  // A keyboard of 336 points, the composer's padding hiding 26 behind it: both 310.
  expect(composerLift(-336, 1, 26)).toBe(310);
  expect(listKeyboardRoom(336, 336, 26)).toBe(310);
  // Gone: nothing.
  expect(composerLift(0, 0, 26)).toBe(0);
  expect(listKeyboardRoom(0, 336, 26)).toBe(0);
  // No offset, or no target yet: the height as is.
  expect(listKeyboardRoom(200, 336, 0)).toBe(200);
  expect(listKeyboardRoom(200, 0, 26)).toBe(200);
  // Part way (the layout guide's reading, its progress against the open height): the same share on both sides.
  expect(composerLift(-168, 0.5, 26)).toBeCloseTo(listKeyboardRoom(168, 336, 26), 6);
  // The suggestion row leaving (360.67 → 320.67 on a 932-point iPhone): the list's end comes down with the dock.
  const gap = composerLift(-320.67, 320.67 / 360.67, 26) - listKeyboardRoom(360.67, 360.67, 26);
  expect(gap).toBeCloseTo(-37.11, 1);
});

test("a cover freezes the list only once a keyboard that was up has gone: no keyboard-tall gap over the dock after", () => {
  const chat = chatScreenSource();
  expect(chat).toMatch(
    /const cover = useCallback\(\(\) => \{\s*covered\.current = true;\s*if \(KeyboardController\.isVisible\(\)\) freezeOnHide\.current = true;\s*else freeze\.value = true;/,
  );
  expect(chat).toMatch(
    /KeyboardEvents\.addListener\("keyboardDidHide", \(\) => \{\s*if \(!freezeOnHide\.current\) return;\s*freezeOnHide\.current = false;\s*if \(covered\.current\) freeze\.value = true;/,
  );
  // The cover gone first: nothing left to freeze.
  expect(chat).toMatch(
    /const uncover = useCallback\(\s*\(now = false\) => \{\s*covered\.current = false;\s*freezeOnHide\.current = false;/,
  );
});

test("a long reply lands at its start only once it is measured, against the room the keyboard leaves", () => {
  const chat = chatScreenSource();
  // The list says a new size from its estimate before it measures the row: an unknown size never counts as tall.
  expect(chat).toContain("if (size === undefined || size <= room.height - BAND_GAP) return;");
  // The keyboard's share is where the dock rides, as it rides (not a notification's height).
  expect(chat).toContain("const keyboard = composerLift(keyboardAt.height.get(), keyboardAt.progress.get(), lift);");
  expect(chat).toContain("return { state, top, height: state.scrollLength - top - dock.get() - keyboard };");
});

test('going to a message takes its place in the list\'s own rows, where the "Novas" line is one', () => {
  const chat = chatScreenSource();
  expect(chat).not.toContain("rowsRef.current.findIndex(");
  expect(chat).toContain("const index = key === undefined ? undefined : listRef.current?.getState().indexByKey(key);");
  // Pins, "Ver resultado" and "Ver" land in the room under the bar.
  expect(chat).toContain('...aimAt(index, 0.4, "start")');
  expect(chat).toContain('...aimAt(index, 0.5, "end")');
});

test('held where the list landed at its end (the "Novas" line, "Ver"), it follows again: no round button over nothing', () => {
  const chat = chatScreenSource();
  expect(chat).toContain('...aimAt(index, 0.5, "end") })?.then(releaseAtEnd);');
  expect(chat).toMatch(/goingToLine\.current = false;\s*\/\/[^\n]*\n\s*releaseAtEnd\(\);\s*revealOpened\(\);/);
});

test("no suggestion pills over the conversation", () => {
  const chat = chatScreenSource();
  expect(chat).not.toContain("composerSuggestions");
  expect(chat).not.toMatch(/\bsuggestions=/);
});

test("who is working is the conversation's last line, scrolling with it: above the composer only before there is one", () => {
  const chat = chatScreenSource();
  // The list's footer, one element for the screen's life: the line redraws with each step of work, the list never does.
  expect(chat).toContain("const WORK_FOOTER = <WorkFooter />;");
  expect(chat).toContain("ListFooterComponent={WORK_FOOTER}");
  expect(chat).toMatch(
    /function WorkFooter\(\) \{\s*const line = useContext\(WorkLineContext\);\s*return line \? <LiveWorkingLine \{\.\.\.line\} \/> : null;/,
  );
  expect(chat).toContain("<WorkLineContext.Provider value={workLine}>");
  expect(chat).toMatch(/member && showList\s*\? \{\s*runs,/);
  // The list follows the footer's size as it follows a new row (Legend List does, unless told only some changes).
  expect(chat).toContain("const GLIDE = { animated: true } as const;");
  // Over the composer only while the conversation has nothing to end with.
  expect(chat).toContain("{member && !awayAsk && !waitingFirst && !showList ? (");
  // The composer's edges and a turn's gap above it, only while the line says something (a return at rest too).
  expect(chat).toContain(
    "const lineInList = useMemo(() => ({ paddingHorizontal: DOCK_SIDE, paddingTop: rhythm.turn }), [rhythm.turn]);",
  );
  expect(chat).toContain("onOpen={openReturns} style={lineInList} />");
  expect(src("features/chat/LiveRows.tsx")).toContain("<View style={[styles.dock, style]}>");
  expect(src("features/chat/Returns.tsx")).toContain("<View style={[styles.dock, style]}>");
});

test('an agent\'s "pensando…" comes with my message, in the same frame: the conversation grows once, with it', () => {
  const chat = chatScreenSource();
  const optimistic = chat.slice(
    chat.indexOf("onOptimistic: (local) => {"),
    chat.indexOf("onSent: (message, local) => {"),
  );
  // On the copy on its way, not from the server's answer (the dock grew while the list was still going down to it).
  expect(optimistic).toContain(
    "if (dmAgentId && !atWork) live.expect(local.threadId ?? local.id, [dmAgentId], local.id);",
  );
  // An agent at work already takes the message into that work: no second "pensando…".
  expect(optimistic).toContain("AT_WORK.has(r.status)");
  // Moved to its server id with it; dropped when it went into work going on, or was never sent.
  expect(chat).toContain("live.retarget(local.id, message.id);");
  expect(chat).toContain("live.forget(message.id, false);");
  expect(chat).toMatch(/live\.forget\(`local-\$\{clientId\}`, true\);/);
  // The socket's copy can come before the answer: the move happens in that same update, so nothing drops out between.
  const live = src("features/chat/live.ts");
  expect(live).toContain("const base = sent?.clientId ? retargeted(state, localIdOf(sent.clientId), sent.id) : state;");
  expect(live).toContain('case "retarget":');
});

test("a read that tells the receipts nothing new doesn't draw the conversation again", () => {
  const live = src("features/chat/live.ts");
  expect(live).toContain(
    "if (seedReceipts(stateRef.current.receipts, messages) === stateRef.current.receipts) return;",
  );
});

test('a picker\'s "preparing" thumbnail comes only once the picker covers the screen', () => {
  const chat = chatScreenSource();
  // Set as the picker opened, it showed in the dock (growing it, moving the conversation) before the picker came up.
  expect(chat).toContain("const covered = setTimeout(() => setPreparing(true), PICKER_COVERS_MS);");
  expect(chat.match(/await whilePicking\(/g)).toHaveLength(2);
  expect(chat).not.toMatch(/setPreparing\(true\);\s*const res = await/);
});
