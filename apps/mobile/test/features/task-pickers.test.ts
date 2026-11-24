import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  audienceReady,
  closeTaskPick,
  firstAgentAdded,
  openTaskPick,
  sameActor,
  taskPickNow,
  toggleActor,
} from "../../src/features/issues/pick";
import { pushedByDefault } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("a task's fields picked on their own screen", () => {
  test("the pick holds what is picked and how it goes back, until its screen closes", () => {
    const picked: (string | null)[] = [];
    openTaskPick({ what: "project", value: null, apply: (id) => picked.push(id) });
    const now = taskPickNow();
    expect(now?.what).toBe("project");
    if (now?.what === "project") now.apply("p1");
    expect(picked).toEqual(["p1"]);
    // Closing the one a screen showed ends it; a pick started meanwhile for the next screen stays.
    const next = { what: "projectFilter" as const, value: "", apply: () => {} };
    openTaskPick(next);
    closeTaskPick(now);
    expect(taskPickNow()).toBe(next);
    closeTaskPick(next);
    expect(taskPickNow()).toBeNull();
  });

  test("the same assignee, nobody included; a list of people that names nobody can't be saved", () => {
    expect(sameActor(null, null)).toBe(true);
    expect(sameActor({ type: "agent", id: "a" }, { type: "agent", id: "a" })).toBe(true);
    expect(sameActor({ type: "agent", id: "a" }, { type: "person", id: "a" })).toBe(false);
    expect(sameActor({ type: "agent", id: "a" }, null)).toBe(false);
    expect(audienceReady({ mode: "everyone" })).toBe(true);
    expect(audienceReady({ mode: "people", userIds: ["me"] })).toBe(true);
    expect(audienceReady({ mode: "people", userIds: [] })).toBe(false);
  });

  test("who does it is several (ADR 0188): a tap adds one last or takes one off; the first agent a task gets starts", () => {
    const ana = { type: "agent" as const, id: "a1" };
    const bia = { type: "agent" as const, id: "a2" };
    const me = { type: "person" as const, id: "me" };
    expect(toggleActor([], ana)).toEqual([ana]);
    expect(toggleActor([me], ana)).toEqual([me, ana]);
    expect(toggleActor([me, ana], me)).toEqual([ana]);
    // An agent and a person with the same id are two.
    expect(toggleActor([ana], { type: "person", id: "a1" })).toEqual([ana, { type: "person", id: "a1" }]);
    // The first agent put on it is asked; with an agent on it already, another one only gets the task.
    expect(firstAgentAdded([me], [me, ana])).toEqual(ana);
    expect(firstAgentAdded([], [ana])).toEqual(ana);
    expect(firstAgentAdded([ana], [ana, bia])).toBeNull();
    expect(firstAgentAdded([], [me])).toBeNull();
    expect(firstAgentAdded([me, ana], [me])).toBeNull();
  });

  test("its screen is pushed with the stack's bar, and goes back with nothing to pick for", () => {
    expect(pushedByDefault("issues/pick")).toBe(true);
    const screen = src("issues/TaskPickScreen.tsx");
    expect(screen).toContain('if (!pick) goBack("/issues");');
    // It takes its pick as it opens, and ends that one only.
    expect(screen).toContain("const [pick] = useState(taskPickNow);");
    expect(screen).toContain("return () => closeTaskPick(pick);");
    // A single choice goes back on its tap, its check on the one in use.
    expect(screen).toContain("checked={c.id === pick.value}");
  });

  test("who does it checks each one that has it, saves each tap at once and stays open until the bar's back", () => {
    const screen = src("issues/TaskPickScreen.tsx");
    const who = screen.slice(screen.indexOf("function WhoPick("), screen.indexOf("function ProjectPick("));
    expect(who).toContain("checked={who ? list.some((a) => sameActor(a, who)) : list.length === 0}");
    expect(who).toContain("if (who) set(toggleActor(list, who));");
    // Written back with the list before it; a save that fails takes its tap back.
    expect(who).toContain("Promise.resolve(pick.apply(next, was)).catch(");
    // Never back on a tap: "Pronto" (and the system's back) go back.
    expect(who).not.toContain("chose(");
    expect(who).toContain('action={{ label: t("mobile.common.done"), onPress: () => goBack() }}');
    // Nova tarefa follows each tap; a task saves it and asks the first agent it gets.
    expect(src("issues/NewIssueForm.tsx")).toContain('pickOn({ what: "who", value: who, apply: setWho })');
    const task = src("issues/IssueScreen.tsx");
    expect(task).toContain('pickAssignee: () => pickOn({ what: "who", value: i.assignees, apply: assign }),');
    expect(task).toContain('.mutateAsync({ type: "update", id: i.id, patch: { assignees: next } })');
    for (const gone of ["AssigneePicker", 'toggle("who")', 'open === "who"'])
      expect([gone, task.includes(gone) || src("issues/NewIssueForm.tsx").includes(gone)]).toEqual([gone, false]);
  });

  test("Nova tarefa opens nothing inside the form: many choices push the picker, a short list is the app's menu", () => {
    const form = src("issues/NewIssueForm.tsx");
    for (const gone of ["setOpen(", 'open === "', "<Filters", "<WhoSeesRows"])
      expect([gone, form.includes(gone)]).toEqual([gone, false]);
    for (const what of ["who", "project", "sees"]) expect(form).toContain(`pickOn({ what: "${what}"`);
    expect(form.match(/chooseAction\(/g)).toHaveLength(2);
    // The rows say how they open: a chevron for a screen, the menu's mark for the app's menu.
    expect(form.match(/\bmenu\b\n/g)).toHaveLength(2);
  });

  test("a task's head and its bar's \"…\" push the same pickers; its priority and due date are the app's menu", () => {
    const screen = src("issues/IssueScreen.tsx");
    const pickers = screen.slice(screen.indexOf("function useIssuePickers("), screen.indexOf("function useIssueMenu("));
    for (const what of ["column", "who", "project"]) expect(pickers).toContain(`what: "${what}"`);
    expect(pickers).toContain('router.push("/issues/pick");');
    expect(pickers.match(/choose\(\n?\s*t\("/g)?.length).toBe(3);
    expect(pickers).not.toContain("sheet.");
    // The bar: Concluir (Reabrir) as its word, "…" beside it as the system's menu on iOS and the app's on Android.
    const bar = screen.slice(screen.indexOf("function IssueBar("), screen.indexOf("function useFinish("));
    expect(bar).toContain("action={{ label: finish.label, disabled: finish.pending, onPress: finish.run }}");
    expect(bar).toContain("menu: items,");
    expect(bar).toContain("chooseAction(");
    for (const gone of ["FinishWord", "IconButton", "ActivityIndicator", "<ActionList"])
      expect([gone, screen.includes(gone)]).toEqual([gone, false]);
  });
});

describe("the other screens of tasks, requests and missions", () => {
  test("a mission draws no large title of its own: the kind in the bar, its name as the page's heading", () => {
    const screen = src("missions/MissionScreen.tsx");
    expect(screen).not.toContain('variant="display"');
    expect(screen).toContain('<Text variant="display2" accessibilityRole="header"');
    expect(screen).toContain('title={t("mobile.mission.kind")}');
    // Its options are a bar button of the system's, not a drawn one; loading is the rows' shape.
    expect(screen).toContain('sf: "ellipsis" as const,');
    expect(screen).not.toContain("IconButton");
    expect(screen).not.toContain("ActivityIndicator");
  });

  test("a request is a pushed screen under the system's bar, no sheet's bar of its own, and loads in its rows' shape", () => {
    const sheet = src("approvals/ApprovalSheet.tsx");
    // ADR 0218 §6: the system's back in a collapsed bar, never the sheets' × and title.
    expect(sheet).toContain('<PushedLargeTitle title="" collapsed grouped keyboard');
    for (const gone of ["<SheetBar", "<SheetScreen"]) expect([gone, sheet.includes(gone)]).toEqual([gone, false]);
    expect(sheet).toContain("<SkeletonList rows={2} />");
    expect(sheet).not.toContain("ActivityIndicator");
    expect(sheet).toContain("<LoadFailed onRetry={() => void approval.refetch()} />");
  });

  test("a computer's line and an agent's waiting line load in rows, and say when they didn't", () => {
    for (const file of ["queue/QueueSheet.tsx", "queue/UsageQueueSheet.tsx"]) {
      const sheet = src(file);
      expect({ file, rows: sheet.includes("<SkeletonList rows={3} />") }).toEqual({ file, rows: true });
      expect({ file, retry: sheet.includes("<LoadFailed onRetry={() => void q.refetch()} />") }).toEqual({
        file,
        retry: true,
      });
      expect({ file, spinner: sheet.includes("<ActivityIndicator color={c.muted} style={styles.loading}") }).toEqual({
        file,
        spinner: false,
      });
    }
  });

  test("an agent's whole waiting line is dropped after the system's alert, never a confirmation opened in the sheet", () => {
    const sheet = src("queue/UsageQueueSheet.tsx");
    const stopAll = sheet.slice(sheet.indexOf("function StopAll("), sheet.indexOf("const N_WIDTH"));
    expect(stopAll).toContain("confirmAction({");
    expect(stopAll).toContain('action: t("usageQueue.yesDontRun"),');
    expect(stopAll).not.toContain("useState");
  });
});
