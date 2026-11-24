import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sameEditors } from "@agenteschat/client/lib/agent-edit";
import { editorsOf, editorsPatch, editorsSummary, editorsValueOf } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { pushedByDefault } from "../main-stack";
import { agent, translator } from "./fixtures";

// An agent's "Who can edit" on the phone (ADR 0085 addendum of 2026-11-17): the web's choice and words, on a pushed
// screen of its own opened from Edit agent.
const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** The source with every run of white space as one space, for checks across a formatter's line breaks. */
const flat = (path: string) => read(path).replace(/\s+/g, " ");

const SCREEN = "src/features/agents/AgentEditorsScreen.tsx";
const ROW = "src/features/agents/EditorsSection.tsx";

const people: Record<string, string> = { "u-ana": "Ana Souza", "u-bruno": "Bruno Lima" };
const roles: Record<string, string> = { "r-support": "Suporte" };
const nameOf = (id: string) => people[id];
const roleName = (id: string) => roles[id];
const nina = agent({
  id: "a-nina",
  name: "Nina",
  ownerUserId: "u-ana",
  editors: { userIds: ["u-bruno"], roleIds: ["r-support"] },
});
const iara = agent({ id: "a-iara", name: "Iara", ownerUserId: "u-ana", editors: { userIds: [], roleIds: [] } });

describe("Who can edit on the phone", () => {
  test("a screen pushed over Edit agent, its row after who talks to it and before the budget and the brakes", () => {
    expect(pushedByDefault("agent-editors/[id]")).toBe(true);
    expect(read("app/(app)/(main)/agent-editors/[id].tsx")).toContain(
      '<AgentEditorsScreen key={id} agentId={id ?? ""} />',
    );
    expect(flat(SCREEN)).toContain('router.push({ pathname: "/agent-editors/[id]", params: { id: agentId } })');
    const edit = read("src/features/agents/AgentEditScreen.tsx");
    const row = edit.indexOf("<EditorsSection agent={agent} />");
    expect(row).toBeGreaterThan(edit.indexOf("t(reachShortKey(reach))"));
    for (const after of ["<BudgetSection agent={agent} />", "<BrakesSection agent={agent} />", "<ReportsToSection"])
      expect({ after, before: row < edit.indexOf(after) }).toEqual({ after, before: true });
  });

  test("the row: who edits it in a line under its name, opened by its owner or who manages it, read by anyone else", () => {
    const row = flat(ROW);
    expect(row).toContain('icon="pen" label={t("editors.section")}');
    // A list of names goes under the label, where it is never cut at the row's end.
    expect(row).toContain("sub={summary(agent)} subLines={2}");
    expect(row).toContain('name: t("common.about", { label: t("editors.section") }), text: t("editors.note"');
    // Who holds the role that answers for it too (ADR 0085, addendum of 2026-11-21).
    expect(row).toContain('const changes = canEditAudience(org ?? undefined, agent, meId ?? "", myRoleIds);');
    expect(row).toContain("{...(changes ? { chevron: true, onPress: () => openAgentEditors(agent.id) } : {})}");
    // Nobody edits how the right hand works; who doesn't see how an agent works gets no editors from the server (the
    // line would name nobody); alone in a personal workspace, it waits until it names someone.
    expect(row).toContain(
      'if (isRightHand(agent) || !seesDetails(agent) || (solo && editorsMode(editorsOf(agent)) === "owner")) return null;',
    );
  });

  test("who doesn't see how it works reads no editors: the screen says its workings are kept, as its public card", async () => {
    // The server blanks its editors for them (ADR 0085 addendum of 2026-11-17): "Only who looks after it" would be wrong.
    const screen = flat(SCREEN);
    expect(screen).toContain("{seesDetails(agent) ? (");
    expect(screen).toContain('<GroupedFooter>{t("profile.detailsHidden", g)}</GroupedFooter>');
    const hiddenFrom = { ...nina, seesDetails: false, editors: { userIds: [], roleIds: [] } };
    const en = await translator("en");
    expect(editorsSummary(en, hiddenFrom, nameOf, roleName)).toBe("Only who looks after it");
    expect(en("profile.detailsHidden", agentGrammar("Nina"))).toBe(
      "Only the people Nina answers, whoever can edit it, its owner and admins see its instructions, tools, memory and usage.",
    );
  });

  test("the form: Save in the bar once the choice changes, the page locked while it saves, then back", () => {
    const screen = flat(SCREEN);
    expect(screen).toContain(
      'busy={update.isPending} action={{ label: t("common.save"), onPress: save, disabled: !changed }}',
    );
    expect(screen).toContain("const changed = !sameEditors(draft, saved);");
    // A back swipe with a choice not saved asks first; one on its way or saved leaves without asking.
    expect(screen).toContain("const leave = useUnsavedGuard(changed && !update.isPending);");
    expect(screen).toContain(
      "{ editors: editorsPatch(draft) }, { onSuccess: () => { leave(); successHaptic(); goBack(); }, onError: failed, },",
    );
    // Only its owner and who manages it change it; anyone else who sees how it works reads who edits it.
    expect(screen).toContain(
      'if (!canEditAudience(org ?? undefined, agent, meId ?? "", myRoleIds)) return <EditorsRead agent={agent} />;',
    );
    // The right hand has none: its address alone goes back. A missing agent says so; loading, the rows' shape.
    expect(screen).toContain("if (rightHand) goBack();");
    expect(screen).toContain("<SkeletonList rows={3} />");
    expect(screen).toContain('<EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />');
  });

  test("the choices as checked rows; under the second, the roles with their marks and the people but its owner", () => {
    const screen = flat(SCREEN);
    expect(screen).toContain('label={t("editors.mode.owner", g)}');
    // A role that answers for it is named as whoever holds it (ADR 0085, addendum of 2026-11-21).
    expect(screen).toContain(
      'sub={ ownerRole ? t("editors.modeText.ownerRole", { ...g, role: ownerRole.name }) : owner ? t("editors.modeText.owner", { ...g, owner }) : t("editors.modeText.noOwner", g) }',
    );
    expect(screen).toContain('checked={draft.mode === "people"} onPress={() => pick("people")}');
    expect(screen).toContain(
      '<GroupedFooter>{t("audience.ownerRoleAlways", { role: ownerRole.name })}</GroupedFooter> ) : owner ? ( <GroupedFooter>{t("audience.ownerAlways", { name: owner })}</GroupedFooter> ) : null}',
    );
    // Every role but "everyone", what a role grants here behind its ⓘ.
    expect(screen).toContain(
      "sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r) && r.id !== agent.ownerRoleId))",
    );
    expect(screen).toContain(
      'hint={{ name: t("common.about", { label: t("audience.roles") }), text: t("editors.rolesHint") }}',
    );
    expect(screen).toContain("leading={<RoleMark color={r.color} icon={r.icon} size={22} />}");
    expect(screen).toContain("[...dir.memberById.values()].filter((m) => m.userId !== agent.ownerUserId)");
    expect(screen).toContain('leading={<Face who={{ type: "person", id: m.userId }} size={26} live={false} />}');
    // A personal workspace's family picks people first, as on the web.
    expect(screen).toContain("{personal ? peopleGroup : roleGroup} {personal ? roleGroup : peopleGroup}");
    expect(screen).toContain('<GroupedFooter>{t("editors.note", g)}</GroupedFooter>');
  });

  test("it opens as saved; the first choice keeps the picks on the page and a save names nobody", () => {
    const value = editorsValueOf(nina);
    expect(value).toEqual({ mode: "people", userIds: ["u-bruno"], roleIds: ["r-support"] });
    expect(editorsPatch(value)).toEqual({ userIds: ["u-bruno"], roleIds: ["r-support"] });
    const owner = { ...value, mode: "owner" as const };
    expect(sameEditors(owner, value)).toBe(false);
    expect(editorsPatch(owner)).toEqual({ userIds: [], roleIds: [] });
    // Naming nobody, it opens on the first choice, and the second with nobody picked is nothing to save.
    const none = editorsValueOf(iara);
    expect(none).toEqual({ mode: "owner", userIds: [], roleIds: [] });
    expect(sameEditors({ ...none, mode: "people" }, none)).toBe(true);
    // Its owner always edits: a named editor who became its owner is never one of the picks.
    expect(editorsOf({ ...nina, ownerUserId: "u-bruno" })).toEqual({ userIds: [], roleIds: ["r-support"] });
  });

  test("the row and the form say it in the web's words", async () => {
    const pt = await translator("pt-BR");
    expect(editorsSummary(pt, iara, nameOf, roleName)).toBe("Só quem cuida dela");
    expect(editorsSummary(pt, nina, nameOf, roleName)).toBe("Ana Souza, Bruno Lima e Suporte");
    expect(pt("editors.title", agentGrammar("Nina"))).toBe("Quem pode editar a Nina");
    expect(pt("editors.modeText.owner", { ...agentGrammar("Nina"), owner: "Ana Souza" })).toBe(
      "Ana Souza, responsável, os administradores e quem edita agentes e fala com a Nina.",
    );
    expect(pt("audience.ownerAlways", { name: "Ana Souza" })).toBe("Ana Souza sempre pode, como responsável.");
    const en = await translator("en");
    expect(en("editors.section")).toBe("Who can edit");
    expect(editorsSummary(en, iara, nameOf, roleName)).toBe("Only who looks after it");
    expect(en("editors.mode.owner", agentGrammar("Iara"))).toBe("Only who looks after Iara");
  });
});
