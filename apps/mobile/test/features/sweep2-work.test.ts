import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Tasks, requests, reminders, routines, missions and dashboards: what the second pass over their screens fixed. */
const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("no field takes the keyboard as its screen or sheet opens", () => {
  test("new items, editors and the reminder wait for the person's tap", () => {
    for (const file of [
      "issues/NewIssueForm.tsx",
      "issues/IssueScreen.tsx",
      "dashboards/NewBoardScreen.tsx",
      "dashboards/BoardEditScreen.tsx",
      "dashboards/WidgetEditScreen.tsx",
      "reminders/RemindSheet.tsx",
    ])
      expect({ file, focus: src(file).includes("autoFocus") }).toEqual({ file, focus: false });
  });

  test("a field that shows in answer to a tap on the same screen may take it", () => {
    // Recusar in the request's sheet shows the reason (opened on refusing, the person taps it first).
    expect(src("approvals/ApprovalSheet.tsx")).toContain("autoFocus={!startRefusing}");
    // New widget's ask, reopened from its folded line; a routine's phrase, from Repetição's last choice.
    expect(src("dashboards/NewWidgetScreen.tsx")).toContain("autoFocus={editing}");
    expect(src("routines/RoutineForm.tsx")).toContain("autoFocus={writing && !phrase}");
  });
});

describe("forms clear the keyboard on both systems and ask before changes go", () => {
  test("the forms stand on the settings' form page, never an iOS-only inset", () => {
    for (const file of [
      "issues/NewIssueForm.tsx",
      "dashboards/NewBoardScreen.tsx",
      "dashboards/BoardEditScreen.tsx",
      "dashboards/WidgetEditScreen.tsx",
      "routines/RoutineForm.tsx",
    ]) {
      const code = src(file);
      expect({
        file,
        page: code.includes("<SettingsPage"),
        iosOnly: code.includes("automaticallyAdjustKeyboardInsets"),
      }).toEqual({ file, page: true, iosOnly: false });
    }
    // Forms of several fields: the bar over the keyboard, and the first field's return goes to the next.
    for (const file of ["issues/NewIssueForm.tsx", "dashboards/BoardEditScreen.tsx", "routines/RoutineForm.tsx"])
      expect({ file, bar: /<SettingsPage[^>]*\btoolbar\b/.test(src(file)) }).toEqual({ file, bar: true });
    expect(src("issues/NewIssueForm.tsx")).toContain("{...NEXT_FIELD}");
    expect(src("dashboards/BoardEditScreen.tsx")).toContain("{...NEXT_FIELD}");
    // New widget's card holds its fields: its own page scrolls them clear of the keyboard.
    const widget = src("dashboards/NewWidgetScreen.tsx");
    expect(widget).toContain("<KeyboardAwareScrollView");
    expect(widget).toContain("bottomOffset={FIELD_CLEARANCE}");
    expect(widget).not.toContain("automaticallyAdjustKeyboardInsets");
  });

  test("leaving with changes asks first; a save that took leaves without asking", () => {
    for (const file of [
      "issues/NewIssueForm.tsx",
      "dashboards/NewBoardScreen.tsx",
      "dashboards/BoardEditScreen.tsx",
      "dashboards/WidgetEditScreen.tsx",
      "dashboards/NewWidgetScreen.tsx",
      "dashboards/ShareScreen.tsx",
      "dashboards/OrganizeScreen.tsx",
      "routines/RoutineForm.tsx",
    ]) {
      const code = src(file);
      expect({ file, guard: code.includes("useUnsavedGuard("), leaves: code.includes("leave();") }).toEqual({
        file,
        guard: true,
        leaves: true,
      });
      expect({ file, own: code.includes("usePreventRemove") }).toEqual({ file, own: false });
    }
    // A routine's defaults filled in as its lists load are not the person's changes.
    const routine = src("routines/RoutineForm.tsx");
    expect(routine).toContain("const leave = useUnsavedGuard(touched);");
    expect(routine).toContain("if (!d.agentId && first) setD((x) => ({ ...x, agentId: first.id }));");
  });
});

describe("real steps, never content swapped in place", () => {
  test("Lembrar's own time is the sheet's next step over the quick times", () => {
    const sheet = src("reminders/RemindSheet.tsx");
    expect(sheet).toContain("sheet.push(");
    expect(sheet).toContain("<RemindAt");
    expect(sheet).not.toContain("setCustom(null)");
    expect(sheet).not.toContain("mobile.remind.quick");
  });

  test("a request's sheet refuses as the cards do: the system's alert on iOS, Cancelar never a drawn Voltar", () => {
    const sheet = src("approvals/ApprovalSheet.tsx");
    expect(sheet).toContain('if (Platform.OS === "ios") promptRefusal(t, name, (why) => done("refuse", false, why));');
    expect(sheet).not.toContain('t("mobile.common.back")');
    expect(sheet).toContain("onPress={startRefusing ? onClose : () => setRefusing(false)}");
    expect(src("approvals/parts.tsx")).toContain("promptRefusal(t, name, send);");
  });

  test("Pin's boards are the app's pushed picker, as New widget's", () => {
    const pin = src("dashboards/PinScreen.tsx");
    expect(pin).toContain("openOptionPick({");
    expect(pin).toContain('router.push("/option-pick");');
    expect(pin).toContain("closeOptionPick()");
    expect(pin).not.toContain("onPress={() => setDest(d.id)}");
    expect(pin).toContain('<EmptyState size="panel" icon="chart" title={t("dashboards.errors.blockNotFound")} />');
  });
});

describe("bars and pulls", () => {
  test("a widget is a detail: the compact bar with its name, not said again in its card", () => {
    const widget = src("dashboards/WidgetScreen.tsx");
    expect(widget).not.toContain("PushedLargeTitle");
    expect(widget).toContain("<PushedHeader");
    expect(widget).toContain("head={null}");
    expect(widget).toContain("{w.canEdit ? <AskChange widget={w} name={look.name} /> : null}");
  });

  test("the Dashboards list's \"+\" is the system's bar button", () => {
    const list = src("dashboards/DashboardsScreen.tsx");
    expect(list).not.toContain("IconButton");
    expect(list).toContain(
      'actions: [{ icon: "plus", sf: "plus", label: t("dashboards.new"), onPress: openNewBoard }]',
    );
  });

  test("a mission and a task refresh on a pull", () => {
    for (const file of ["missions/MissionScreen.tsx", "task-manager/TaskScreen.tsx"])
      expect({ file, pull: src(file).includes("refreshControl={<RefreshControl") }).toEqual({ file, pull: true });
  });

  test("a task deleted from a link lands on Tarefas; its activity that didn't load offers Retry", () => {
    const screen = src("issues/IssueScreen.tsx");
    expect(screen).toContain('goBack("/issues");');
    expect(screen).not.toContain("router.back()");
    expect(src("issues/IssueActivity.tsx")).toContain("<LoadFailed onRetry={() => void activity.refetch()} />");
  });
});
