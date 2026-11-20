import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import type { ImportCard } from "@agenteschat/client/lib/import/flow";
import {
  handleAfterRename,
  handleProblemText,
  presetChannels,
  presetLevels,
  ROLE_DEFAULTS,
  ROLE_IDS,
  takenHandles,
} from "@agenteschat/client/lib/new-agent";
import { gradientOf, hsvToHex } from "@agenteschat/ui/agent/engine";
import { hsvRgb, rgbHex, tileOf } from "../../src/features/agents/color-pick";
import {
  type AgentDraft,
  agentChanges,
  editableFields,
  fullLook,
  sameLook,
  shuffleLook,
} from "../../src/features/agents/edit";
import {
  firstBlockedStep,
  IMPORT_MARKS,
  importMarkCards,
  NEW_AGENT_PHONE_STEPS,
  roleLine,
  stepBlocked,
} from "../../src/features/agents/new-agent";
import { AGENT_ACCESSORIES, AGENT_COLORS, AGENT_EYES, agentLook } from "../../src/features/shared/logic";
import { translator } from "./fixtures";

describe("an agent's look", () => {
  test("every part is set, unknown values fall back to the default agent", () => {
    expect(fullLook({ color: "rose", eyes: "happy", accessory: "crown" })).toEqual({
      color: "rose",
      eyes: "happy",
      accessory: "crown",
    });
    expect(fullLook({ color: "plaid", eyes: 3 })).toEqual({ color: "sky", eyes: "round", accessory: "none" });
    expect(fullLook(undefined)).toEqual({ color: "sky", eyes: "round", accessory: "none" });
  });

  test("a custom #rrggbb color is kept (lowercased); a malformed one falls back to sky", () => {
    expect(fullLook({ color: "#AABBCC", eyes: "round" }).color).toBe("#aabbcc");
    expect(agentLook({ appearance: { color: "#123abc", eyes: "dots" } }).color).toBe("#123abc");
    expect(fullLook({ color: "#abc", eyes: "round" }).color).toBe("sky");
    expect(agentLook({ appearance: { color: "#12345g" } }).color).toBe("sky");
  });

  test("Sortear always lands on a different look", () => {
    const now = fullLook({ color: "sky", eyes: "round", accessory: "none" });
    // A "random" that would give the same look every time still moves.
    expect(
      sameLook(
        shuffleLook(now, () => 0),
        now,
      ),
    ).toBe(false);
    let seed = 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < 50; i++) {
      const next = shuffleLook(now, rand);
      expect(sameLook(next, now)).toBe(false);
      expect(AGENT_COLORS).toContain(next.color);
      expect(AGENT_EYES).toContain(next.eyes);
      expect(AGENT_ACCESSORIES).toContain(next.accessory);
    }
  });

  test("every role starts with a look the phone can draw", () => {
    for (const id of ROLE_IDS) {
      const look = ROLE_DEFAULTS[id].look;
      expect(fullLook(look)).toEqual(look);
    }
  });
});

describe("editing an agent", () => {
  const saved: AgentDraft = {
    name: "Nina",
    handle: "nina",
    role: "Atendimento",
    instructions: "Responde clientes.",
    look: { color: "teal", eyes: "happy", accessory: "headset" },
    audience: { mode: "people", userIds: ["u-bia"], roleIds: [], consultable: true },
  };

  test("who manages it changes everything, who edits it its role and instructions, its person its look too, others nothing", () => {
    expect([...editableFields({ admin: true, owner: false })].sort()).toEqual([
      "consultable",
      "instructions",
      "look",
      "name",
      "role",
    ]);
    // Someone its "Who can edit" names: how it works, never its name or its look.
    expect([...editableFields({ admin: false, editor: true, owner: false })]).toEqual(["role", "instructions"]);
    // Its owner always edits it (ADR 0085 addendum of 2026-11-17), named an editor or not.
    expect([...editableFields({ admin: false, owner: true })]).toEqual(["role", "instructions", "look", "consultable"]);
    expect([...editableFields({ admin: false, editor: true, owner: true })]).toEqual([
      "role",
      "instructions",
      "look",
      "consultable",
    ]);
    expect(editableFields({ admin: false, owner: false }).size).toBe(0);
    expect(editableFields({ admin: false, editor: false, owner: false }).size).toBe(0);
  });

  test("a save sends only what changed and may change", () => {
    const all = editableFields({ admin: true, owner: false });
    expect(agentChanges(saved, saved, all)).toBeNull();
    expect(
      agentChanges(saved, { ...saved, name: " Nina B ", look: { ...saved.look, accessory: "crown" } }, all),
    ).toEqual({ name: "Nina B", appearance: { color: "teal", eyes: "happy", accessory: "crown" } });
    // Its person's draft can't carry a new name, only how it works.
    const own = editableFields({ admin: false, owner: true });
    expect(agentChanges(saved, { ...saved, name: "Outra", instructions: "x" }, own)).toEqual({ instructions: "x" });
    // Who edits it sends its role and instructions, never a new name or look.
    const editor = editableFields({ admin: false, editor: true, owner: false });
    const renamed = { ...saved, name: "Outra", look: { ...saved.look, accessory: "crown" as const } };
    expect(agentChanges(saved, { ...renamed, role: " Suporte " }, editor)).toEqual({ role: "Suporte" });
    expect(agentChanges(saved, renamed, editor)).toBeNull();
    // An emptied name is never sent.
    expect(agentChanges(saved, { ...saved, name: "  " }, all)).toBeNull();
  });

  test("other agents can consult it (ADR 0085 addendum): its person or an admin switches it, sent with its audience", () => {
    const off = { ...saved, audience: { ...saved.audience, consultable: false } };
    const sent = { audience: { mode: "people", userIds: ["u-bia"], roleIds: [], consultable: false } };
    expect(agentChanges(saved, off, editableFields({ admin: false, owner: true }))).toEqual(sent);
    expect(agentChanges(saved, off, editableFields({ admin: true, owner: false }))).toEqual(sent);
    expect(agentChanges(saved, off, editableFields({ admin: false, owner: false }))).toBeNull();
    // Who talks to it stays with its person and who manages it: editing it doesn't change that.
    expect(agentChanges(saved, off, editableFields({ admin: false, editor: true, owner: false }))).toBeNull();
  });

  test("someone who can't edit reads the instructions drawn as Markdown, as the chat does, never its marks", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "features", "agents", "AgentEditScreen.tsx"),
      "utf8",
    );
    const readOnly = src.slice(
      src.indexOf('fields.has("instructions") ?'),
      src.indexOf("</GroupedList>", src.indexOf('fields.has("instructions") ?')),
    );
    expect(readOnly).toContain("<MessageText body={agent.instructions} />");
    expect(readOnly).not.toContain("{agent.instructions ||");
  });

  test("Editar hints the role the way Criar agente does, not with a one-word example", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "src", "features", "agents", f), "utf8");
    for (const screen of ["AgentEditScreen.tsx", "NewAgentScreen.tsx"]) {
      expect(src(screen).match(/<RoleInput[\s\S]*?\/>/)?.[0]).toContain('placeholder={t("agent.roleHelp")}');
    }
  });
});

describe("renaming an agent on the phone", () => {
  const saved: AgentDraft = {
    name: "Ada",
    handle: "ada",
    role: "Dev",
    instructions: "",
    look: fullLook(undefined),
    audience: { mode: "everyone", userIds: [], roleIds: [], consultable: true },
  };
  const all = editableFields({ admin: true, owner: false });

  test("its @ follows the new name until one is typed in Menções; Salvar sends both", () => {
    const draft = { ...saved, name: "Claudio", handle: handleAfterRename(saved, "Claudio") };
    expect(draft.handle).toBe("claudio");
    expect(agentChanges(saved, draft, all)).toEqual({ name: "Claudio", handle: "claudio" });
    expect(agentChanges(saved, { ...saved, handle: handleAfterRename(saved, "Ada", "dra") }, all)).toEqual({
      handle: "dra",
    });
    expect(handleAfterRename(saved, "Claudio", "clau")).toBe("clau");
    // Neither the agent's own person nor who edits it moves its @: it goes with its name, who manages it renames it.
    expect(agentChanges(saved, draft, editableFields({ admin: false, owner: true }))).toBeNull();
    expect(agentChanges(saved, draft, editableFields({ admin: false, editor: true, owner: false }))).toBeNull();
  });

  test("Menções says why a taken @ can't be used and offers a free one; its own old @ comes back", async () => {
    const t = await translator("pt-BR");
    const agents = [
      { id: "a1", handle: "ada", previousHandles: ["dra"] },
      { id: "a2", handle: "atlas", previousHandles: ["zeus"] },
    ];
    const taken = takenHandles(agents, [{ handle: "walter" }, { handle: null }], "a1");
    expect(handleProblemText(t, "atlas", taken)).toBe("@atlas já é de outro agente ou pessoa. Que tal @atlas-2?");
    expect(handleProblemText(t, "zeus", taken)).toBe("@zeus já é de outro agente ou pessoa. Que tal @zeus-2?");
    expect(handleProblemText(t, "walter", taken)).toBe("@walter já é de outro agente ou pessoa. Que tal @walter-2?");
    expect(handleProblemText(t, "dra", taken)).toBeNull();
    expect(handleProblemText(t, "x", taken)).toBe(
      "Use de 2 a 32 letras minúsculas, números, hífen ou _, começando por letra ou número.",
    );
    expect(t("agent.handleMoves", { handle: "claudio", old: "ada" })).toBe(
      "As menções passam a ser por @claudio. @ada continua funcionando.",
    );
    expect(t("agent.identityHelp")).toBe("É como todo mundo vê o agente. O @ acompanha o nome.");
  });

  test("a notice that names an old @ shows the agent now called by another", () => {
    const byHandle = agentsByAnyHandle([
      { id: "a1", name: "Claudio", handle: "claudio", previousHandles: ["ada"] },
      { id: "a2", name: "Atlas", handle: "atlas" },
    ]);
    expect(byHandle.get("ada")?.name).toBe("Claudio");
    expect(byHandle.get("claudio")?.name).toBe("Claudio");
    expect(byHandle.get("atlas")?.name).toBe("Atlas");
  });
});

describe("creating an agent on the phone", () => {
  const taken = new Set(["ada", "walt"]);

  test("the steps that fit a thumb, in the web's order", () => {
    expect([...NEW_AGENT_PHONE_STEPS]).toEqual(["role", "identity", "instructions", "review"]);
  });

  test("a role first, then a name and a free @", () => {
    const draft = { role: null, name: "", handle: "", taken };
    expect(firstBlockedStep(draft)).toBe(0);
    expect(stepBlocked("identity", { ...draft, role: "dev", name: "Ada", handle: "ada" })).toBe(true);
    expect(stepBlocked("identity", { ...draft, role: "dev", name: "Ada", handle: "ada-2" })).toBe(false);
    expect(stepBlocked("identity", { ...draft, role: "dev", name: "Ada", handle: "-x" })).toBe(true);
    expect(firstBlockedStep({ role: "custom", name: "Lu", handle: "lu", taken })).toBe(-1);
  });

  test("a role brings its apps' levels and the channels the workspace has", () => {
    const items = [
      { id: "c1", def: { id: "github" } },
      { id: "c2", def: { id: "stripe" } },
      { id: "c3", def: null },
    ];
    // An app the role doesn't list is open, as for every agent there.
    expect(presetLevels("dev", items)).toEqual({ c1: "write", c2: "write", c3: "none" });
    expect(presetLevels("finance", items)).toEqual({ c1: "write", c2: "read", c3: "none" });
    expect(presetLevels("custom", items)).toEqual({ c1: "write", c2: "write", c3: "none" });
    const channels = [
      { id: "1", name: "Engenharia" },
      { id: "2", name: "geral" },
    ];
    expect(presetChannels("dev", channels)).toEqual(["1"]);
    expect(presetChannels("assistant", channels)).toEqual(["2"]);
  });

  test("the import row's tile: the first source apps with a logo, three at most, in the import's order", async () => {
    expect(importMarkCards((c): c is ImportCard => true)).toEqual(["grok-bot", "chatgpt-dots", "openbotrun"]);
    expect(IMPORT_MARKS).toBe(3);
    // One without a logo of its own gives its place to the next; none at all leaves the tile empty.
    expect(importMarkCards((c): c is ImportCard => c !== "grok-bot")).toEqual([
      "chatgpt-dots",
      "openbotrun",
      "openmausbot",
    ]);
    expect(importMarkCards((c): c is ImportCard => c.length === 0)).toEqual([]);
    // The row sits right under "Do zero" with the web card's words, and the channels say what marking one does.
    const screen = await Bun.file(
      new URL("../../src/features/agents/NewAgentScreen.tsx", import.meta.url).pathname,
    ).text();
    expect(screen).toContain('label={t("newAgent.importCard")}');
    expect(screen).toContain('sub={t("newAgent.importCardLine")}');
    expect(screen.indexOf("<ImportMarks />")).toBeLessThan(screen.indexOf("newAgent.roleGroups.personal"));
    expect(screen).toContain('<GroupedHeader>{t("newAgent.channelsJoin")}</GroupedHeader>');
  });

  test("a preset's line: what it does, then who it starts as, the agent's name kept as written", () => {
    expect(roleLine("Programa, revisa PRs e investiga bugs.", "Começa como Ada", "Ada", "pt-BR")).toBe(
      "Programa, revisa PRs e investiga bugs · começa como Ada",
    );
    // German nouns keep their capital; a line that starts with the name keeps it, and a full stop goes like a period.
    expect(roleLine("Programmiert, prüft PRs und untersucht Bugs.", "Startet als Ada", "Ada", "de")).toBe(
      "Programmiert, prüft PRs und untersucht Bugs · Startet als Ada",
    );
    expect(roleLine("コードを書き、PRをレビューし、バグを調査します。", "Adaとして開始", "Ada", "ja")).toBe(
      "コードを書き、PRをレビューし、バグを調査します · Adaとして開始",
    );
  });

  test("Create agent on the grouped gray: the step in the bar, presets as checked rows, a level picked from a list", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (f: string) => Bun.file(new URL(`../../src/features/agents/${f}`, import.meta.url).pathname).text();
    const [screen, look] = await Promise.all([read("NewAgentScreen.tsx"), read("LookPicker.tsx")]);
    // Where the step stands is the bar's line under its title ("2 of 4"), never a progress bar of its own.
    expect(screen).not.toContain("newAgent.stepOf");
    expect(screen).toContain('return at ? t("mobile.choices.step", at) : undefined;');
    expect(screen).toContain('<PushedHeader title={t("newAgent.title")} subtitle={subtitle} solid={false} grouped />');
    expect(screen).not.toContain("function StepBar");
    // A role is a row with the check, never a ringed card; with none chosen yet there is no bar to press.
    expect(screen).toContain("checked={role === id}");
    expect(screen).not.toContain("RoleCard");
    expect(screen).toMatch(/bar=\{\s*change \|\| role !== null \?/);
    // A proposal's levels come from the app's picker of the three, never cycled by taps.
    expect(screen).not.toContain("nextLevel");
    expect(screen).toContain("const chooseLevel = (title: string, current: string, choose: (level: Level) => void) =>");
    expect(screen).toContain("chooseLevel(app, level, (l) => setProposedLevel(i.id, l))");
    // The look in the list: swatches checked inside, the eyes and the accessory each on a pushed screen of checked
    // rows (ADR 0135: screens, never sheets).
    expect(screen).toContain("<LookList look={look} onChange={(value) => editNewAgent({ look: value })} />");
    expect(look).toContain("checked={o.key === value}");
    expect(look).toContain('router.push("/agent-look");');
    expect(look).not.toContain("<Sheet");
  });

  test("the custom color sheet: starts from the current color, applies it on done, keeps the drag from the scroll", async () => {
    // The sheet is a component the tests can't render: what it wires in, as text.
    const sheet = await Bun.file(new URL("../../src/features/agents/ColorSheet.tsx", import.meta.url).pathname).text();
    expect(sheet).toContain("hexToHsv(pickerStart(value))");
    expect(sheet).toMatch(
      /const done = \(\) => \{\s*\(onDone \?\? onChange\)\(hex as `#\$\{string\}`\);\s*onClose\(\);/,
    );
    expect(sheet).toContain('label={doneLabel ?? t("look.useColor")} onPress={done}');
    expect(sheet).toContain("onSubmitEditing={done}");
  });

  test("a drag on the color sheet runs on the UI thread and tells the form once, when the finger lets go", async () => {
    const sheet = await Bun.file(new URL("../../src/features/agents/ColorSheet.tsx", import.meta.url).pathname).text();
    // A pan from the first touch, never the JS responder: the sheet's scroll can't take the drag over mid-way.
    expect(sheet).not.toMatch(/onResponder(Grant|Move)/);
    expect(sheet.match(/usePanGesture\(\{\s*minDistance: 0,/g)).toHaveLength(2);
    // Each move writes shared values only; the form hears the color on release, never per move.
    expect(
      sheet.match(
        /onFinalize: \(\) => \{\s*"worklet";\s*scheduleOnRN\(commit, hue\.get\(\), sat\.get\(\), val\.get\(\)\);/g,
      ),
    ).toHaveLength(2);
    expect(sheet).not.toMatch(/onUpdate: \(e\) => \{[^}]*(setHsv|onChange|scheduleOnRN)/);
    // The thumbs move by transform, the tile is drawn from the color on the UI thread.
    expect(sheet).toContain("{ translateX: sat.get() * areaW.get() - THUMB / 2 }");
    expect(sheet).toContain("const tile = useDerivedValue(() => tileOf(hue.get(), sat.get(), val.get()));");
  });

  test("the color sheet's UI-thread tile is the engine's own, over the whole picker", () => {
    const steps = Array.from({ length: 21 }, (_, i) => i / 20);
    const hues = [...Array.from({ length: 52 }, (_, i) => i * 7), 359, 359.5];
    for (const h of hues)
      for (const s of steps)
        for (const v of steps) {
          const hex = hsvToHex(h, s, v);
          expect(rgbHex(hsvRgb(h, s, v))).toBe(hex);
          expect(tileOf(h, s, v)).toEqual(gradientOf(hex));
        }
  });
});
