/**
 * Test fake — skills (apps/server/src/routes/app/skills.ts), same shapes:
 * - `GET/POST …/skills`, `POST …/skills/import { url } | { url, paths } | { zipBase64 }`,
 *   `GET/PATCH/DELETE …/skills/{id}`, `POST …/skills/{id}/reimport`,
 *   `POST …/skills/{id}/update[/approve|/dismiss|/reopen|/undo]`
 * - `GET/PUT …/agents/{id}/skills` → `{ skills: (Skill & { enabled })[] }`
 * A repository's root holds three skills to pick and one that can't be installed (`{ choices, skipped }`), and `list`
 * lists a folder's one skill. `acme/secret` is private and no connection reaches it; `contoso/skills` is private and the
 * workspace's GitHub connection reads it (`github()`: that connection, none or one GitHub refuses). Scripts are listed
 * as `ignored`. "Revisão de PR" was changed by Ada since its link last wrote it, so its update from its link waits.
 * A skill's page (`GET …/skills/{id}`) adds who knows it, its uses this week and its last ones, and its history: how
 * it came, the agents' changes, and what people did here (a change asked in words, the link's version chosen), the
 * newest of those undoable while `lastUpdate` stands. "Teach something new" writes the same draft from any words
 * (`POST …/skills/draft`, `…/skills/drafted`), and an agent's suggestions are the library's used skills it lacks.
 */
import { type ApiClient, ApiError, type SkillDetail, type SkillEvent, type SkillUse } from "@agenteschat/client";
import { clone, type MockContext, MockNotFoundError, mockId, perOrg } from "./context";

const CHOICES = [
  { path: "skills/deploy", name: "deploy", description: "Antes de qualquer deploy." },
  { path: "skills/review", name: "review", description: "Revisa um pull request." },
  { path: "skills/triage", name: "triage", description: "Organiza as issues novas." },
];
/** What a fake .zip holds to stand for several skills' folders. */
export const SEVERAL_SKILLS = "several-skills";
const SKIPPED = [
  {
    path: "skills/claude-api",
    code: "skill.invalid_description",
    message: "description: 1 to 1024 characters",
    params: { max: 1024 },
  },
];

export function createFakeSkills(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
  github: () => "none" | "refused" | "ok" = () => "none",
): ApiClient["skills"] {
  const assigned = new Map<string, Set<string>>();
  /** Names of skills removed here: a pick named like one replaces it, as the server says. */
  const removed = new Set<string>();
  /** A waiting update a person chose, as it was: Desfazer makes it wait again. */
  const chosen = new Map<string, Pick<SkillDetail, "body" | "pendingUpdate" | "pending">>();
  /** "Agentes melhoram as skills sozinhos" per workspace (on unless saved off). */
  const settingsOf = new Map<string, boolean>();
  /** How many times each agent loaded each skill in the last 7 days. */
  const weekUses = new Map<string, Map<string, number>>();
  /** A skill's last uses, newest first. */
  const usesOf = new Map<string, SkillUse[]>();
  /** What people did to a skill here, oldest first: a change asked in words, its link's version chosen. */
  const eventsOf = new Map<string, SkillEvent[]>();
  /** A skill's text before the change asked in words: Desfazer brings it back. */
  const asked = new Map<string, string>();
  /** "Aprende sozinho" per agent (on unless turned off). */
  const learnsOf = new Map<string, boolean>();
  const store = perOrg(async (orgId) => {
    const list: SkillDetail[] = [];
    if (!ctx.seed) return list;
    const agents = await ctx.lookup.agents(orgId);
    const now = ctx.now().toISOString();
    const add = (s: Omit<SkillDetail, "id" | "metadata" | "createdAt" | "updatedAt">) => {
      const skill: SkillDetail = { ...s, id: mockId("skill"), metadata: {}, createdAt: now, updatedAt: now };
      list.push(skill);
      return skill.id;
    };
    const review = add({
      name: "Revisão de PR",
      description: "Use quando pedirem para revisar um pull request.",
      version: 3,
      source: "url",
      sourceUrl: "https://github.com/acme/skills/tree/main/pr-review",
      defaultForNewAgents: false,
      body: "# Revisão de PR\n\n1. Leia o diff inteiro.\n2. Rode os testes.\n\n```bash\nbun test\n```",
      // Ada added the tests step after its link last wrote it: "Atualizar do link" waits for a person.
      changes: [
        {
          id: mockId("change"),
          agentId: agents[0]?.id ?? "",
          at: now,
          before: "# Revisão de PR\n\n1. Leia o diff inteiro.",
          after: "# Revisão de PR\n\n1. Leia o diff inteiro.\n2. Rode os testes.\n\n```bash\nbun test\n```",
          undone: false,
        },
      ],
      files: [
        { path: "SKILL.md", size: 120, mime: "text/markdown", status: "stored" },
        { path: "checklist.md", size: 40, mime: "text/markdown", status: "stored" },
        { path: "scripts/lint.sh", size: 30, mime: "text/x-sh", status: "script" },
        { path: "scripts/old.py", size: 20, mime: "text/x-python", status: "ignored" },
      ],
    });
    add({
      name: "Relatório semanal",
      description: "Monta o resumo da semana.",
      version: 1,
      source: "manual",
      sourceUrl: null,
      defaultForNewAgents: true,
      body: "# Relatório semanal\n\nDecisões, entregas e pendências.",
      files: [{ path: "SKILL.md", size: 60, mime: "text/markdown", status: "stored" }],
    });
    const care = add({
      name: "Atendimento",
      description: "Tom e respostas padrão do suporte.",
      version: 2,
      source: "upload",
      sourceUrl: null,
      defaultForNewAgents: false,
      body: "# Atendimento\n\nSeja breve e cordial.",
      // An agent improved it by itself (Agentes melhoram as skills sozinhos): Desfazer in its sheet.
      lastUpdate: { fromVersion: 1, at: now, agentId: agents[0]?.id ?? null },
      changes: [
        {
          id: mockId("change"),
          agentId: agents[0]?.id ?? "",
          at: now,
          before: "# Atendimento\n\nSeja cordial.",
          after: "# Atendimento\n\nSeja breve e cordial.",
          undone: false,
        },
      ],
      files: [
        { path: "SKILL.md", size: 50, mime: "text/markdown", status: "stored" },
        { path: "respostas.txt", size: 20, mime: "text/plain", status: "stored" },
      ],
    });
    const first = agents[0];
    if (first) {
      assigned.set(first.id, new Set([review]));
      weekUses.set(review, new Map([[first.id, 12]]));
      weekUses.set(care, new Map([[first.id, 3]]));
      // Its last uses: one asked in #eng, one in a conversation the viewer isn't in.
      const eng = (await ctx.lookup.channels(orgId)).find((c) => c.name === "eng");
      const message = eng && (await ctx.lookup.messages?.(orgId))?.find((m) => m.channelId === eng.id);
      const nowhere = { channelId: null, channelKind: null, channelName: null, threadId: null, messageId: null };
      usesOf.set(review, [
        {
          ...nowhere,
          at: now,
          agentId: first.id,
          ...(eng ? { channelId: eng.id, channelKind: "channel", channelName: eng.name } : {}),
          messageId: message?.id ?? null,
          excerpt: "revisa o PR do login",
        },
        { ...nowhere, at: now, agentId: first.id, excerpt: null },
      ]);
    }
    return list;
  });
  const find = async (orgId: string, id: string) => {
    const s = (await store(orgId)).find((x) => x.id === id);
    if (!s) throw new MockNotFoundError("Skill não encontrada.");
    return s;
  };
  /** The agents with it on, in the workspace's order. */
  const holders = async (orgId: string, id: string) =>
    (await ctx.lookup.agents(orgId)).filter((a) => assigned.get(a.id)?.has(id)).map((a) => a.id);
  const weekOf = (id: string) => [...(weekUses.get(id)?.values() ?? [])].reduce((n, x) => n + x, 0);
  /** A line of a skill's history done here. */
  const remember = async (id: string, e: Pick<SkillEvent, "kind" | "words" | "before" | "after">, person = true) => {
    const me = person ? (await ctx.lookup.me())?.user.id : undefined;
    const by = me ? { type: "person" as const, id: me } : null;
    const line = { ...e, id: mockId("event"), at: ctx.now().toISOString(), by, undoable: false, undone: false };
    eventsOf.set(id, [...(eventsOf.get(id) ?? []), line]);
  };
  /** Its history, newest first: what was done here, the agents' changes, then how it came. */
  const historyOf = async (s: SkillDetail): Promise<SkillEvent[]> => {
    const me = (await ctx.lookup.me())?.user.id;
    const quiet = { words: null, before: null, after: null, undoable: false, undone: false };
    const agents = (s.changes ?? []).map(
      (c): SkillEvent => ({
        ...quiet,
        id: c.id,
        at: c.at,
        kind: "agent",
        by: { type: "agent", id: c.agentId },
        before: c.before,
        after: c.after,
        undone: c.undone,
      }),
    );
    const madeBy = s.origin === "agent" && s.ownerAgentId ? { type: "agent" as const, id: s.ownerAgentId } : null;
    const origin: SkillEvent = {
      ...quiet,
      id: `made-${s.id}`,
      at: s.createdAt,
      kind: s.source === "manual" || madeBy ? "created" : "installed",
      by: madeBy ?? (me ? { type: "person", id: me } : null),
    };
    const all = [...clone(eventsOf.get(s.id) ?? []).reverse(), ...agents, origin];
    // As the server: Desfazer takes back the newest change while the skill still is at the version it made.
    const newest = all.find((e) => e.kind === "agent" || e.kind === "rewritten" || e.kind === "link");
    if (newest && s.lastUpdate && !newest.undone) newest.undoable = true;
    return all;
  };
  const detail = async (orgId: string, id: string): Promise<SkillDetail> => {
    const s = await find(orgId, id);
    return {
      ...clone(s),
      agentIds: await holders(orgId, id),
      weekUses: weekOf(id),
      uses: clone(usesOf.get(id) ?? []),
      history: await historyOf(s),
    };
  };
  /** A personal install is its installer's, as the server keeps it (`ownerUserId`). */
  const ownerOf = async (personal?: boolean) => (personal ? { ownerUserId: (await ctx.lookup.me())?.user.id } : {});
  const make = async (
    orgId: string,
    s: Omit<SkillDetail, "id" | "metadata" | "createdAt" | "updatedAt" | "version">,
  ) => {
    const at = ctx.now().toISOString();
    const skill: SkillDetail = { ...s, id: mockId("skill"), version: 1, metadata: {}, createdAt: at, updatedAt: at };
    (await store(orgId)).push(skill);
    return clone(skill);
  };
  /** Its link read again: the workspace's GitHub refusing as the server does, else a new version. */
  const readAgain = async (orgId: string, id: string) => {
    const s = await find(orgId, id);
    if (s.sourceVia && github() === "none") {
      throw new ApiError(400, "skill.connection_gone", "The GitHub connection that read contoso/skills is gone", {
        repo: "contoso/skills",
      });
    }
    if (s.sourceVia && github() === "refused") {
      throw new ApiError(400, "github.repo_missing", "contoso/skills is private or doesn't exist on GitHub", {
        repo: "contoso/skills",
        connection: "refused",
        app: false,
      });
    }
    s.version += 1;
    return clone(s);
  };
  /** The picks as the server lists them: one named like a skill installed, or removed, says it replaces it. */
  const marked = async (orgId: string, choices: typeof CHOICES) => {
    const names = new Set((await store(orgId)).map((s) => s.name));
    return clone(choices).map((c) =>
      names.has(c.name)
        ? { ...c, replaces: "installed" as const }
        : removed.has(c.name)
          ? { ...c, replaces: "removed" as const }
          : c,
    );
  };
  const forAgent = async (orgId: string, agentId: string) =>
    (await store(orgId)).map(({ body: _b, files: _f, ...s }) => ({
      ...clone(s),
      enabled: assigned.get(agentId)?.has(s.id) ?? false,
      agentWeekUses: weekUses.get(s.id)?.get(agentId) ?? 0,
    }));
  return {
    list: async (orgId) =>
      Promise.all(
        (await store(orgId)).map(async ({ body: _b, files: _f, ...s }) => ({
          ...clone(s),
          agentIds: await holders(orgId, s.id),
          weekUses: weekOf(s.id),
        })),
      ),
    get: detail,
    create: async (orgId, input) => {
      log("skills.create", orgId, input);
      return make(orgId, {
        ...(await ownerOf(input.personal)),
        name: input.name,
        description: input.description,
        body: input.body,
        source: "manual",
        sourceUrl: null,
        defaultForNewAgents: input.defaultForNewAgents ?? false,
        files: [{ path: "SKILL.md", size: input.body.length, mime: "text/markdown", status: "stored" }],
      });
    },
    import: async (orgId, input, upload) => {
      log("skills.import", orgId, input);
      upload?.onProgress?.(1);
      const url = "url" in input ? input.url : null;
      const hidden = url?.includes("/acme/secret")
        ? "acme/secret"
        : url?.includes("/contoso/") && github() !== "ok"
          ? "contoso/skills"
          : null;
      if (hidden) {
        throw new ApiError(400, "github.repo_missing", `${hidden} is private or doesn't exist on GitHub`, {
          repo: hidden,
          connection: github(),
          app: false,
        });
      }
      const via = url?.includes("/contoso/") ? { via: "github" as const } : {};
      if (url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)) {
        return { choices: await marked(orgId, CHOICES), skipped: clone(SKIPPED), ...via };
      }
      if (url && "list" in input && input.list) return { choices: await marked(orgId, CHOICES.slice(0, 1)), ...via };
      // A .zip sent in a conversation (an agent's card) is listed to pick, as a link is.
      if ("fileId" in input) return { choices: await marked(orgId, CHOICES.slice(0, 1)) };
      // A .zip of several skills (its bytes say so here) lists them to pick, as a link does.
      if ("zipBase64" in input && atob(input.zipBase64).includes(SEVERAL_SKILLS)) {
        return { choices: await marked(orgId, CHOICES) };
      }
      const name = url ? (url.split("/").filter(Boolean).pop() ?? "skill") : "Skill enviada";
      return make(orgId, {
        ...(await ownerOf(input.personal)),
        name,
        description: url ? "Instalada do GitHub." : "Enviada em .zip.",
        body: `# ${name}`,
        source: url ? "url" : "upload",
        sourceUrl: url,
        ...(via.via ? { sourceVia: via.via } : {}),
        defaultForNewAgents: false,
        files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
      });
    },
    importPicked: async (orgId, url, paths, forAgentId, personal) => {
      log(
        "skills.importPicked",
        orgId,
        url,
        paths,
        ...(forAgentId ? [forAgentId] : []),
        ...(personal ? [personal] : []),
      );
      const installed: SkillDetail[] = [];
      for (const path of paths) {
        const choice = CHOICES.find((c) => c.path === path);
        if (!choice) throw new MockNotFoundError("Skill não encontrada.");
        installed.push(
          await make(orgId, {
            ...(await ownerOf(personal)),
            name: choice.name,
            description: choice.description,
            body: `# ${choice.name}`,
            source: "url",
            sourceUrl: `${url}/tree/HEAD/${path}`,
            ...(url.includes("/contoso/") ? { sourceVia: "github" as const } : {}),
            defaultForNewAgents: false,
            files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
          }),
        );
      }
      return installed;
    },
    importPickedFile: async (orgId, fileId, paths, forAgentId, personal) => {
      log(
        "skills.importPickedFile",
        orgId,
        fileId,
        paths,
        ...(forAgentId ? [forAgentId] : []),
        ...(personal ? [personal] : []),
      );
      const installed: SkillDetail[] = [];
      for (const path of paths) {
        const choice = CHOICES.find((c) => c.path === path);
        if (!choice) throw new MockNotFoundError("Skill não encontrada.");
        installed.push(
          await make(orgId, {
            ...(await ownerOf(personal)),
            name: choice.name,
            description: choice.description,
            body: `# ${choice.name}`,
            source: "upload",
            sourceUrl: null,
            defaultForNewAgents: false,
            files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
          }),
        );
      }
      return installed;
    },
    importPickedZip: async (orgId, zipBase64, paths, personal, upload) => {
      log("skills.importPickedZip", orgId, paths, ...(personal ? [personal] : []));
      upload?.onProgress?.(1);
      if (!atob(zipBase64).includes(SEVERAL_SKILLS)) throw new MockNotFoundError("Skill não encontrada.");
      const installed: SkillDetail[] = [];
      for (const path of paths) {
        const choice = CHOICES.find((c) => c.path === path);
        if (!choice) throw new MockNotFoundError("Skill não encontrada.");
        installed.push(
          await make(orgId, {
            ...(await ownerOf(personal)),
            name: choice.name,
            description: choice.description,
            body: `# ${choice.name}`,
            source: "upload",
            sourceUrl: null,
            defaultForNewAgents: false,
            files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
          }),
        );
      }
      return installed;
    },
    update: async (orgId, id, patch) => {
      log("skills.update", orgId, id, patch);
      const s = await find(orgId, id);
      const edits = patch.description !== undefined || patch.body !== undefined;
      Object.assign(s, patch, { updatedAt: ctx.now().toISOString(), version: s.version + (edits ? 1 : 0) });
      return clone(s);
    },
    reimport: async (orgId, id) => {
      log("skills.reimport", orgId, id);
      return readAgain(orgId, id);
    },
    updateFromSource: async (orgId, id) => {
      log("skills.updateFromSource", orgId, id);
      const s = await find(orgId, id);
      // The agents changed it since its link last wrote it, and its link has a new version and script: it waits.
      const since = s.changes?.find((c) => !c.undone);
      if (since && s.source === "url" && !s.sourceVia) {
        const at = ctx.now().toISOString();
        s.pendingUpdate = { scripts: ["scripts/lint.sh"], at, dismissed: false, dismissedAt: null, edited: true };
        s.pending = {
          body: `${since.before}\n2. Rode o lint.`,
          description: s.description,
          base: {
            body: since.before,
            description: s.description,
            at: new Date(Date.parse(since.at) - 60_000).toISOString(),
          },
          files: [{ path: "scripts/lint.sh", before: "eslint .", after: "biome check .", large: false }],
        };
        return { status: "waiting" as const, skill: clone(s), scripts: s.pendingUpdate.scripts };
      }
      return { status: "updated" as const, skill: await readAgain(orgId, id) };
    },
    approveUpdate: async (orgId, id) => {
      log("skills.approveUpdate", orgId, id);
      const s = await find(orgId, id);
      const before = s.body;
      if (s.pendingUpdate && s.pending)
        chosen.set(id, { body: s.body, pendingUpdate: s.pendingUpdate, pending: s.pending });
      if (s.pending && s.pending.body !== before)
        await remember(id, { kind: "link", words: null, before, after: s.pending.body }, false);
      Object.assign(s, {
        body: s.pending?.body ?? s.body,
        pendingUpdate: null,
        pending: null,
        lastUpdate: { fromVersion: s.version, at: ctx.now().toISOString(), agentId: null, waited: true },
        version: s.version + 1,
      });
      return { status: "updated" as const, skill: clone(s) };
    },
    dismissUpdate: async (orgId, id) => {
      log("skills.dismissUpdate", orgId, id);
      const s = await find(orgId, id);
      if (s.pendingUpdate)
        s.pendingUpdate = { ...s.pendingUpdate, dismissed: true, dismissedAt: ctx.now().toISOString() };
      return clone(s);
    },
    reopenUpdate: async (orgId, id) => {
      log("skills.reopenUpdate", orgId, id);
      const s = await find(orgId, id);
      if (s.pendingUpdate) s.pendingUpdate = { ...s.pendingUpdate, dismissed: false, dismissedAt: null };
      return clone(s);
    },
    undoUpdate: async (orgId, id) => {
      log("skills.undoUpdate", orgId, id);
      const s = await find(orgId, id);
      const back = s.lastUpdate?.waited ? chosen.get(id) : undefined;
      const last = s.lastUpdate?.agentId ? s.changes?.find((c) => !c.undone) : undefined;
      const was = s.lastUpdate?.byUserId ? asked.get(id) : undefined;
      // The line of what was done here (the link's version chosen, a change asked in words) is undone with it.
      const done = s.lastUpdate?.waited || s.lastUpdate?.byUserId ? eventsOf.get(id)?.at(-1) : undefined;
      if (last) last.undone = true;
      if (done) done.undone = true;
      Object.assign(s, {
        lastUpdate: null,
        version: s.version + 1,
        ...(last ? { body: last.before } : {}),
        ...(was !== undefined ? { body: was } : {}),
        ...(back ?? {}),
      });
      return clone(s);
    },
    remove: async (orgId, id) => {
      log("skills.remove", orgId, id);
      const list = await store(orgId);
      const i = list.findIndex((x) => x.id === id);
      const gone = list[i];
      if (gone) removed.add(gone.name);
      if (i >= 0) list.splice(i, 1);
      for (const set of assigned.values()) set.delete(id);
    },
    settings: async (orgId) => ({ agentsImprove: settingsOf.get(orgId) ?? true }),
    saveSettings: async (orgId, input) => {
      log("skills.saveSettings", orgId, input);
      settingsOf.set(orgId, input.agentsImprove);
      return { agentsImprove: input.agentsImprove };
    },
    draft: async (orgId, input) => {
      log("skills.draft", orgId, input);
      if (!input.words.trim()) throw new ApiError(400, "skill.draft_empty", "Say how the task is done.");
      // The same skill from any words; a change asked adds its step.
      const base = input.draft ?? {
        name: "reembolsos",
        description: "Use quando chegar um pedido de reembolso.",
        body: "# Reembolsos\n\n1. Confira se o pedido está dentro de 7 dias.\n2. Responda o cliente.",
      };
      const change = input.draft ? input.change?.trim() : undefined;
      return {
        name: base.name,
        title: "Reembolsos",
        summary: "Quando chegar um pedido de reembolso.",
        icon: "wallet",
        description: base.description,
        body: change ? `${base.body}\n3. ${change}` : base.body,
        // The workspace's app it uses, which none of the chosen agents uses yet.
        apps: [{ id: "mail", label: "E-mail", missing: [...(input.agentIds ?? [])] }],
      };
    },
    saveDraft: async (orgId, input) => {
      log("skills.saveDraft", orgId, input);
      const { agentIds, personal, defaultForNewAgents, ...draft } = input;
      const made = await make(orgId, {
        ...(await ownerOf(personal)),
        ...draft,
        source: "manual",
        sourceUrl: null,
        defaultForNewAgents: defaultForNewAgents ?? false,
        files: [{ path: "SKILL.md", size: draft.body.length, mime: "text/markdown", status: "stored" }],
      });
      for (const agentId of agentIds) assigned.set(agentId, new Set(assigned.get(agentId)).add(made.id));
      return detail(orgId, made.id);
    },
    rewrite: async (orgId, id, words) => {
      log("skills.rewrite", orgId, id, words);
      const change = words.trim();
      if (!change) throw new ApiError(400, "skill.change_empty", "Say what to change.");
      const s = await find(orgId, id);
      const me = (await ctx.lookup.me())?.user.id ?? null;
      const before = s.body;
      asked.set(id, before);
      Object.assign(s, {
        body: `${before}\n\n${change}`,
        version: s.version + 1,
        lastUpdate: { fromVersion: s.version, at: ctx.now().toISOString(), agentId: null, byUserId: me },
        updatedAt: ctx.now().toISOString(),
      });
      await remember(id, { kind: "rewritten", words: change, before, after: s.body });
      return detail(orgId, id);
    },
    suggestions: async (orgId, agentId) =>
      (await store(orgId))
        .filter((s) => !s.ownerUserId && !assigned.get(agentId)?.has(s.id) && weekOf(s.id) > 0)
        .map((s) => ({ skillId: s.id, why: `Pedidos assim chegaram ${weekOf(s.id)} vezes esta semana.` })),
    learns: async (_orgId, agentId) => learnsOf.get(agentId) ?? true,
    setLearns: async (orgId, agentId, on) => {
      log("skills.setLearns", orgId, agentId, on);
      learnsOf.set(agentId, on);
    },
    zipUrl: (orgId, id) => `/api/app/orgs/${orgId}/skills/${id}/download`,
    forAgent,
    setForAgent: async (orgId, agentId, skills) => {
      log("skills.setForAgent", orgId, agentId, skills);
      // As the server: only the skills listed change.
      const on = new Set(assigned.get(agentId));
      for (const s of skills) on[s.enabled ? "add" : "delete"](s.skillId);
      assigned.set(agentId, on);
      return forAgent(orgId, agentId);
    },
  };
}
