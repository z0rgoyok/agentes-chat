import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { activityText, toolActivity } from "@agenteschat/client/lib/activity";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { setNavigateAway } from "@/lib/navigate";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { SEVERAL_SKILLS } from "./fakes/skills";
import { proceed, startAs } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const pickTab = async (tab: HTMLElement) => {
  tab.focus();
  await key(tab, "Enter");
  await act(async () => fireEvent.mouseDown(tab));
};
/** Opens a menu (Radix: keyboard) from its trigger and gives the menu. */
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await key(trigger, "Enter");
  await settle(2);
  return screen().getByRole("menu");
};
/** Picks `item` from the "…" (More actions) inside `where`. */
const fromMenu = async (where: HTMLElement, item: string) => {
  const menu = await openMenu(within(where).getAllByRole("button", { name: "Mais ações" })[0] as HTMLElement);
  await click(within(menu).getByRole("menuitem", { name: item }));
  await settle(6);
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args.slice(1));

/** Skills, the page of its own (`path`: its search, or a skill's id after a slash). */
const page = async (path = "", state = seedState(), api = createFakeApi(state)) => {
  const { router } = await renderApp(`/org/${ORG_ID}/skills${path}`, { api });
  await settle(8);
  return { state, api, router };
};
const skillsPage = () => document.querySelector(".sk-page") as HTMLElement;
const list = () => within(skillsPage()).getByRole("list", { name: "Skills" });
/** The list's lines, by the name each shows (a skill's, or its repository's). */
const shown = () =>
  [...list().querySelectorAll(":scope > .sk-row:not([data-in-group])")].map(
    (r) => r.querySelector(".sk-row__name > :first-child")?.textContent,
  );
const row = (name: string) => within(list()).getByRole("link", { name }).closest(".sk-row") as HTMLElement;
/** "Have a skill ready? Bring it from a GitHub link or upload a .zip", under the list. */
const footer = (name: string) =>
  within(skillsPage().querySelector(".sk-foot") as HTMLElement).getByRole("button", { name });
const tabs = () => within(skillsPage()).getByRole("tablist", { name: "Filtrar skills" });
/** A skill's page. */
const one = () => document.querySelector(".sk-one") as HTMLElement;
const strip = () => one().querySelector(".sk-strip") as HTMLElement;
const changes = () => within(one()).getByRole("region", { name: "Mudanças" });
const historyLines = () => [...changes().querySelectorAll(".sk-line b")].map((b) => b.textContent);
const seeded = async () => {
  const state = seedState();
  const api = createFakeApi(state);
  const [review, weekly, care] = await api.skills.list(ORG_ID);
  if (!review || !weekly || !care) throw new Error("no skills");
  return { state, api, review, weekly, care };
};

describe("Skills, a page of its own", () => {
  test("the list: each skill with its line, the faces of who knows it and its uses this week, the most used first", async () => {
    const { router } = await page();
    expect(skillsPage().textContent).toContain("O que o time da Acme sabe fazer.");
    expect(shown()).toEqual(["Revisão de PR", "Atendimento", "Relatório semanal"]);
    const review = row("Revisão de PR");
    expect(review.textContent).toContain("Use quando pedirem para revisar um pull request.");
    expect(within(review).getByRole("img", { name: "Ada" })).toBeTruthy();
    expect(review.querySelector(".sk-num")?.textContent).toBe("12");
    expect(row("Atendimento").querySelector(".sk-num")?.textContent).toBe("3");
    // Nobody knows it and nobody used it: no faces, a dash.
    expect(within(row("Relatório semanal")).queryByRole("img")).toBeNull();
    expect(row("Relatório semanal").querySelector(".sk-num")?.textContent).toBe("—");
    // Two people in the workspace: their own skills get a tab; none learned by an agent yet, so no tab for those.
    expect(
      within(tabs())
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Tudo 3", "Só minhas 0"]);

    await click(within(list()).getByRole("link", { name: "Revisão de PR" }));
    await settle(6);
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/skills/.+`));
    expect(one().querySelector("h1")?.textContent).toBe("Revisão de PR");
  });

  test("a repository's skills share a line that opens to them; Aprendidas and Só minhas; the search folds accents", async () => {
    const { state, api, weekly } = await seeded();
    await api.skills.importPicked(ORG_ID, "https://github.com/acme/skills", ["skills/deploy", "skills/triage"]);
    await api.skills.update(ORG_ID, weekly.id, { origin: "agent", ownerAgentId: ADA_ID } as never);
    await api.skills.create(ORG_ID, {
      name: "meu-tom",
      description: "Ao escrever e-mails.",
      body: "# Tom",
      personal: true,
    });
    await page("", state, api);
    // Revisão de PR came from the same repository: the three in one line, where the most used of them stands.
    expect(shown()).toEqual(["acme/skills", "Atendimento", "meu-tom", "Relatório semanal"]);
    const repo = within(list()).getByRole("button", { name: "acme/skills" });
    const line = repo.closest(".sk-row") as HTMLElement;
    expect(line.textContent).toContain("3 skills");
    expect(line.textContent).toContain("Revisão de PR, deploy, triage");
    expect(within(line).getByRole("img", { name: "Ada" })).toBeTruthy();
    expect(repo.getAttribute("aria-expanded")).toBe("false");
    await click(repo);
    expect(repo.getAttribute("aria-expanded")).toBe("true");
    expect([...list().querySelectorAll(".sk-row[data-in-group] .sk-row__link")].map((a) => a.textContent)).toEqual([
      "Revisão de PR",
      "deploy",
      "triage",
    ]);

    await pickTab(within(tabs()).getByRole("tab", { name: /^Aprendidas pelos agentes/ }));
    expect(shown()).toEqual(["Relatório semanal"]);
    expect(row("Relatório semanal").textContent).toContain("aprendida pela Ada");
    await pickTab(within(tabs()).getByRole("tab", { name: /^Só minhas/ }));
    expect(shown()).toEqual(["meu-tom"]);
    expect(row("meu-tom").textContent).toContain("só sua");

    await pickTab(within(tabs()).getByRole("tab", { name: /^Tudo/ }));
    const search = within(skillsPage()).getByRole("searchbox", { name: "Buscar skill" });
    await type(search, "relatorio");
    expect(shown()).toEqual(["Relatório semanal"]);
    // While searching, a repository's skill stands on its own.
    await type(search, "triage");
    expect(shown()).toEqual(["triage"]);
    await type(search, "nada assim");
    expect(skillsPage().textContent).toContain("Nenhuma skill com “nada assim”.");
  });

  test("who manages agents sees others' personal skills by name and person, with Remover only", async () => {
    const { state, api } = await seeded();
    const joao = state.members.find((m) => m.userId !== state.me?.user.id);
    const theirs = await api.skills.create(ORG_ID, { name: "propostas", description: "De outra pessoa.", body: "# x" });
    // Someone else's personal skill, as the server lists it to an admin.
    await api.skills.update(ORG_ID, theirs.id, { ownerUserId: joao?.userId } as never);
    await page("", state, api);
    const theirsRow = within(list()).getByText("propostas").closest(".sk-row") as HTMLElement;
    expect(theirsRow.textContent).toContain(`Pessoal de ${joao?.name}`);
    // No page to open and nothing of what it says.
    expect(within(theirsRow).queryByRole("link")).toBeNull();
    expect(theirsRow.textContent).not.toContain("De outra pessoa.");
    const menu = await openMenu(within(theirsRow).getByRole("button", { name: "Mais ações" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Remover"]);
    await click(within(menu).getByRole("menuitem", { name: "Remover" }));
    await click(
      within(screen().getByRole("dialog", { name: "Remover propostas?" })).getByRole("button", { name: "Remover" }),
    );
    await settle(4);
    expect(calls(state, "skills.remove")).toEqual([[theirs.id]]);
    expect(screen().getByText("propostas removida.")).toBeTruthy();
  });

  test("Agentes melhoram as skills sozinhos: the workspace's switch in the page's menu; a skill's own follows it", async () => {
    const { state } = await page();
    const menu = await openMenu(within(skillsPage()).getByRole("button", { name: "Mais ações" }));
    const all = within(menu).getByRole("menuitemcheckbox", { name: /^Agentes melhoram as skills sozinhos/ });
    expect(all.getAttribute("aria-checked")).toBe("true");
    await click(all);
    await settle(4);
    expect(calls(state, "skills.saveSettings")).toEqual([[{ agentsImprove: false }]]);
    await key(menu, "Escape");
    await settle(2);

    await click(within(list()).getByRole("link", { name: "Atendimento" }));
    await settle(6);
    const own = within(await openMenu(within(one()).getByRole("button", { name: "Mais ações" }))).getByRole(
      "menuitemcheckbox",
      { name: /^Agentes melhoram esta skill sozinhos/ },
    );
    // Not set for this skill: it shows the workspace's choice.
    expect(own.getAttribute("aria-checked")).toBe("false");
    await click(own);
    await settle(4);
    expect(calls(state, "skills.update").at(-1)?.at(-1)).toEqual({ agentsImprove: true });
  });

  test("Ensinar algo novo: in words, the right hand writes it, Ajustar changes it, then it is saved for who will know it", async () => {
    const { state, router } = await page();
    await click(within(skillsPage()).getByRole("button", { name: "Ensinar algo novo" }));
    const dialog = () => screen().getByRole("dialog", { name: "Ensinar algo novo" });
    const words = "Toda segunda, responder os pedidos de reembolso.";
    await type(within(dialog()).getByRole("textbox", { name: "O que o time precisa saber fazer?" }), words);
    const who = await openMenu(dialog().querySelector(".sk-who button") as HTMLElement);
    await click(within(who).getByRole("menuitemcheckbox", { name: "Ada" }));
    await key(who, "Escape");
    await settle(2);
    expect(dialog().querySelector(".sk-who")?.textContent).toContain("Ada");

    await click(within(dialog()).getByRole("button", { name: "Escrever a skill" }));
    await settle(6);
    expect(calls(state, "skills.draft")).toEqual([[{ words, agentIds: [ADA_ID] }]]);
    // What it wrote, to read before saving, and the app it uses that Ada doesn't yet.
    expect(dialog().textContent).toContain("Escrevi assim. Confira antes de salvar.");
    expect(dialog().querySelector(".sk-teach__head h3")?.textContent).toBe("Reembolsos");
    expect(dialog().textContent).toContain("Confira se o pedido está dentro de 7 dias.");
    expect(dialog().textContent).toContain("Ada ainda não usa E-mail.");
    expect(within(dialog()).getByRole("link", { name: "Dar acesso" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${ADA_ID}?tab=access`,
    );

    await type(within(dialog()).getByRole("textbox", { name: "Ajustar" }), "Avise o financeiro no fim");
    await click(within(dialog()).getByRole("button", { name: "Ajustar" }));
    await settle(6);
    expect(calls(state, "skills.draft").at(-1)?.[0]).toMatchObject({
      words,
      draft: { name: "reembolsos" },
      change: "Avise o financeiro no fim",
    });
    expect(dialog().textContent).toContain("Avise o financeiro no fim");

    await click(within(dialog()).getByRole("button", { name: "Salvar e ensinar" }));
    await settle(8);
    expect(calls(state, "skills.saveDraft")[0]?.[0]).toMatchObject({
      name: "reembolsos",
      title: "Reembolsos",
      agentIds: [ADA_ID],
    });
    expect(screen().getByText("Reembolsos está pronta. Ada já sabe.")).toBeTruthy();
    // Its page opens: Ada knows it.
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/skills/.+`));
    expect(one().querySelector("h1")?.textContent).toBe("Reembolsos");
    expect(strip().textContent).toContain("Ada");
  });

  test("a member: their own skills only, written for them; the team's read only", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const api = createFakeApi(state);
    const [review] = await api.skills.list(ORG_ID);
    await page("", state, api);
    // The page's menu has the other ways in, and not the workspace's switch.
    const menu = await openMenu(within(skillsPage()).getByRole("button", { name: "Mais ações" }));
    expect(within(menu).queryByRole("menuitemcheckbox")).toBeNull();
    await key(menu, "Escape");
    await settle(2);
    await click(within(skillsPage()).getByRole("button", { name: "Ensinar algo novo" }));
    const dialog = () => screen().getByRole("dialog", { name: "Ensinar algo novo" });
    // Theirs alone: no "For whom".
    expect(within(dialog()).queryByRole("combobox", { name: "Para quem" })).toBeNull();
    await type(within(dialog()).getByRole("textbox", { name: "O que seus agentes precisam saber fazer?" }), "Meu tom.");
    await click(within(dialog()).getByRole("button", { name: "Escrever a skill" }));
    await settle(6);
    expect(calls(state, "skills.draft")[0]?.[0]).toMatchObject({ personal: true });
    await click(within(dialog()).getByRole("button", { name: "Salvar" }));
    await settle(8);
    expect(calls(state, "skills.saveDraft")[0]?.[0]).toMatchObject({ personal: true, agentIds: [] });
    expect(screen().getByText("Reembolsos está pronta. Ensine a um agente na página dela.")).toBeTruthy();
    // Theirs to change.
    expect(within(one()).getByRole("textbox", { name: "Peça uma mudança" })).toBeTruthy();
    cleanup();

    await page(`/${review?.id}`, state, api);
    expect(one().querySelector("h1")?.textContent).toBe("Revisão de PR");
    expect(within(one()).queryByRole("button", { name: "Ensinar a outro agente" })).toBeNull();
    expect(within(strip()).queryByRole("button", { name: "Mudar" })).toBeNull();
    expect(within(one()).queryByRole("textbox", { name: "Peça uma mudança" })).toBeNull();
    const its = await openMenu(within(one()).getByRole("button", { name: "Mais ações" }));
    expect(
      within(its)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Baixar .zip"]);
  });

  test("Skills' old address in Settings opens the page, at the skill, or with the link it was reading", async () => {
    const { state, api, review } = await seeded();
    const { router } = await renderApp(`/org/${ORG_ID}/settings/skills?skill=${review.id}`, { api });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/skills/${review.id}`);
    expect(one().querySelector("h1")?.textContent).toBe("Revisão de PR");
    cleanup();

    const folder = "https://github.com/acme/skills/tree/main/deploy";
    const back = await renderApp(`/org/${ORG_ID}/settings/skills?install=${encodeURIComponent(folder)}`, {
      api: createFakeApi(state),
    });
    await settle(8);
    expect(back.router.state.location.pathname).toBe(`/org/${ORG_ID}/skills`);
    const dialog = screen().getByRole("dialog", { name: "Trazer de um link do GitHub" });
    expect((within(dialog).getByRole("textbox", { name: "Link do GitHub" }) as HTMLInputElement).value).toBe(folder);
  });
});

describe("a skill's page", () => {
  test("what it teaches, the files it uses, who knows it, its week and last uses; Remover names who loses it", async () => {
    const { state, api, review } = await seeded();
    const { router } = await page(`/${review.id}`, state, api);
    expect(one().querySelector("h1")?.textContent).toBe("Revisão de PR");
    const body = one().querySelector(".sk-one__body") as HTMLElement;
    expect(within(body).getByRole("heading", { name: "Revisão de PR" })).toBeTruthy();
    expect(body.querySelector("pre.code-card__code code")?.textContent).toBe("bun test");
    // Its files, scripts too for who manages it; one an older import only listed isn't one it uses.
    const files = [...one().querySelectorAll(".sk-files__one")].map((f) => f.textContent);
    expect(files).toContain("checklist.md");
    expect(files).toContain("scripts/lint.sh");
    expect(files).not.toContain("scripts/old.py");
    expect(within(strip()).getByRole("img", { name: "Ada" })).toBeTruthy();
    expect(strip().textContent).toContain("12 vezes");
    expect(strip().textContent).toContain("Link do GitHub");
    const uses = within(one()).getByRole("region", { name: "Últimas vezes" });
    expect(uses.textContent).toContain("“revisa o PR do login”");
    expect(uses.textContent).toContain("Ada em #eng");
    expect(uses.textContent).toContain("Numa conversa que você não vê");

    await fromMenu(one(), "Remover");
    const confirm = screen().getByRole("dialog", { name: "Remover Revisão de PR?" });
    expect(confirm.textContent).toContain("Ada usa esta skill e deixa de ter acesso a ela.");
    await click(within(confirm).getByRole("button", { name: "Remover" }));
    await settle(8);
    expect(calls(state, "skills.remove")).toEqual([[review.id]]);
    expect(screen().getByText("Revisão de PR removida.")).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/skills`);
    expect(shown()).toEqual(["Atendimento", "Relatório semanal"]);
  });

  test("one that isn't there says so; one that failed to load offers Tentar de novo, which brings it", async () => {
    const { state, api, review } = await seeded();
    const get = api.skills.get;
    api.skills.get = async () => {
      throw new ApiError(404, "not_found", "Skill not found");
    };
    await page(`/${review.id}`, state, api);
    expect(one().textContent).toContain("Esta skill não está aqui");
    expect(within(one()).queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    cleanup();

    let offline = true;
    api.skills.get = (...args) => (offline ? Promise.reject(new Error("offline")) : get(...args));
    await page(`/${review.id}`, state, api);
    expect(one().textContent).not.toContain("Esta skill não está aqui");
    offline = false;
    await click(within(one()).getByRole("button", { name: "Tentar de novo" }));
    await settle(8);
    expect(one().querySelector("h1")?.textContent).toBe("Revisão de PR");
  });

  test("who knows it: Mudar gives it or takes it away, one call per agent changed", async () => {
    const { state, api, review } = await seeded();
    await page(`/${review.id}`, state, api);
    await click(within(strip()).getByRole("button", { name: "Mudar" }));
    const pick = screen().getByRole("dialog", { name: "Agentes com Revisão de PR" });
    await click(within(pick).getByRole("switch", { name: "Ada" }));
    await click(within(pick).getByRole("switch", { name: "Atlas" }));
    await click(within(pick).getByRole("button", { name: "Salvar" }));
    await settle(8);
    expect(calls(state, "skills.setForAgent")).toEqual([
      [ADA_ID, [{ skillId: review.id, enabled: false }]],
      [ATLAS_ID, [{ skillId: review.id, enabled: true }]],
    ]);
    expect(screen().queryByRole("dialog", { name: "Agentes com Revisão de PR" })).toBeNull();
    expect(within(strip()).getByRole("img", { name: "Atlas" })).toBeTruthy();
    expect(within(strip()).queryByRole("img", { name: "Ada" })).toBeNull();
  });

  test("its changes: each opened in place, Desfazer on the newest; a change asked in words applies with Desfazer", async () => {
    const { state, api, care } = await seeded();
    await page(`/${care.id}`, state, api);
    expect(historyLines()).toEqual(["Ada melhorou", "Walter instalou"]);
    const show = within(changes()).getByRole("button", { name: "Ver mudança" });
    await click(show);
    const diff = within(changes()).getByRole("group", { name: "Ada melhorou" });
    expect(diff.querySelector(".ac-diff__block--add")?.textContent).toContain("Seja breve e cordial.");
    await click(within(changes()).getByRole("button", { name: "Esconder mudança" }));
    expect(within(changes()).queryByRole("group")).toBeNull();
    await click(within(changes()).getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(calls(state, "skills.undoUpdate")).toEqual([[care.id]]);
    expect(screen().getByText("Atendimento voltou como estava.")).toBeTruthy();
    expect(changes().textContent).toContain("desfeita");
    expect(within(changes()).queryByRole("button", { name: "Desfazer" })).toBeNull();
    expect(one().querySelector(".sk-one__body")?.textContent).not.toContain("breve");

    await type(within(one()).getByRole("textbox", { name: "Peça uma mudança" }), "Termine com uma saudação");
    await click(within(one()).getByRole("button", { name: "Pedir" }));
    await settle(8);
    expect(calls(state, "skills.rewrite")).toEqual([[care.id, "Termine com uma saudação"]]);
    expect(screen().getByText("Atendimento mudou como você pediu.")).toBeTruthy();
    expect(one().querySelector(".sk-one__body")?.textContent).toContain("Termine com uma saudação");
    expect(historyLines()[0]).toBe("Walter pediu: “Termine com uma saudação”");
    // The newest change is the one Undo takes back.
    const newest = changes().querySelector(".sk-line") as HTMLElement;
    await click(within(newest).getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(calls(state, "skills.undoUpdate")).toHaveLength(2);
    expect(one().querySelector(".sk-one__body")?.textContent).not.toContain("Termine com uma saudação");
  });

  test("a waiting update: what each side changed, who and when, the choice and its Desfazer either way", async () => {
    const { state, api, review } = await seeded();
    await page(`/${review.id}`, state, api);
    await fromMenu(one(), "Atualizar do link");
    const card = () => within(one()).getByRole("region", { name: "Atualização esperando" });
    expect(card().textContent).toContain("O link tem uma versão nova, e os agentes também mudaram esta skill");
    expect(card().textContent).toContain("Ada mudou esta skill, a última vez");
    expect(card().textContent).toContain("Escolha qual versão fica. Dá para desfazer depois.");
    // The two changes side by side: the agents' and the link's.
    const added = (name: string) =>
      [...within(card()).getByRole("group", { name }).querySelectorAll(".ac-diff__block--add")]
        .map((b) => b.textContent)
        .join(" ");
    expect(added("O que os agentes mudaram")).toContain("Rode os testes.");
    expect(added("O que mudou no link")).toContain("Rode o lint.");

    // Keep the agents' version: said with Undo, and the page keeps a line with its own.
    await click(within(card()).getByRole("button", { name: "Manter a dos agentes" }));
    await settle(6);
    expect(calls(state, "skills.dismissUpdate")).toEqual([[review.id]]);
    expect(screen().getByText("Revisão de PR continua com a versão dos agentes.")).toBeTruthy();
    expect(within(one()).queryByRole("region", { name: "Atualização esperando" })).toBeNull();
    const kept = one().querySelector(".sk-quiet") as HTMLElement;
    expect(kept.textContent).toContain("Ficou a versão dos agentes");
    await click(within(kept).getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(calls(state, "skills.reopenUpdate")).toEqual([[review.id]]);

    // Use the link's version: the link's text, and a line in its changes whose Undo makes it wait again.
    await click(within(card()).getByRole("button", { name: "Usar a versão do link" }));
    await settle(6);
    expect(screen().getByText("Revisão de PR agora usa a versão do link.")).toBeTruthy();
    expect(one().querySelector(".sk-one__body")?.textContent).toContain("Rode o lint.");
    const newest = changes().querySelector(".sk-line") as HTMLElement;
    expect(newest.querySelector("b")?.textContent).toBe("Atualizada do link");
    await click(within(newest).getByRole("button", { name: "Ver mudança" }));
    expect(within(newest).getByRole("group", { name: "Atualizada do link" }).textContent).toContain("Rode o lint.");
    await click(within(newest).getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(calls(state, "skills.undoUpdate")).toEqual([[review.id]]);
    expect(card().textContent).toContain("O link tem uma versão nova");

    // The list says it waits for a choice.
    await click(one().querySelector(".ac-back") as HTMLElement);
    await settle(6);
    expect(row("Revisão de PR").textContent).toContain("Escolher versão");
  });
});

describe("installing a skill from a link or a .zip", () => {
  test("Enviar um .zip: a .zip past the limit is refused when picked; one on its way shows how much went, and Cancelar stops it", async () => {
    const { api } = await page();
    const pending: { input: unknown; progress?: (sent: number) => void; signal?: AbortSignal }[] = [];
    api.skills.import = (_org, input, upload) =>
      new Promise((_, reject) => {
        pending.push({ input, progress: upload?.onProgress, signal: upload?.signal });
        upload?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const pick = async (dialog: HTMLElement, name: string, size: number) => {
      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([new Uint8Array([80, 75, 3, 4])], name, { type: "application/zip" });
      Object.defineProperty(file, "size", { value: size });
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });
    };
    await click(footer("enviar um .zip"));
    let dialog = screen().getByRole("dialog", { name: "Enviar um .zip" });
    await pick(dialog, "repositorio-inteiro.zip", 150 * 1024 * 1024);
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "repositorio-inteiro.zip tem 150 MB. O .zip de uma skill pode ter até 56 MB.",
    );
    expect((within(dialog).getByRole("button", { name: "Instalar" }) as HTMLButtonElement).disabled).toBe(true);
    // The way out is a button: a GitHub link, which reads only the skill's folder.
    await click(within(dialog).getByRole("button", { name: "Usar um link do GitHub" }));
    expect(within(dialog).getByRole("textbox", { name: "Link do GitHub" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(2);

    await click(footer("enviar um .zip"));
    dialog = screen().getByRole("dialog", { name: "Enviar um .zip" });
    await pick(dialog, "skill.zip", 4);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(4);
    expect(pending).toHaveLength(1);
    await act(async () => pending[0]?.progress?.(0.42));
    expect(dialog.textContent).toContain("Enviando o arquivo… 42%");
    // Nothing to change while it goes: the picker is locked.
    expect(within(dialog).getByRole("button", { name: "Escolher .zip" }).closest("fieldset")?.disabled).toBe(true);
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(4);
    expect(pending[0]?.signal?.aborted).toBe(true);
    expect(screen().queryByRole("dialog", { name: "Enviar um .zip" })).toBeNull();
  });

  test("Trazer de um link do GitHub and Enviar um .zip: each installs and opens the new skill's page", async () => {
    const { state } = await page();
    await click(footer("Trazer de um link do GitHub"));
    let dialog = screen().getByRole("dialog", { name: "Trazer de um link do GitHub" });
    await type(within(dialog).getByRole("textbox", { name: "Link do GitHub" }), "nao-e-link");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    expect(dialog.textContent).toContain("Use um link do GitHub");
    await type(
      within(dialog).getByRole("textbox", { name: "Link do GitHub" }),
      "https://github.com/acme/skills/tree/main/deploy",
    );
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(8);
    expect(calls(state, "skills.import")[0]?.[0]).toEqual({ url: "https://github.com/acme/skills/tree/main/deploy" });
    expect(one().querySelector("h1")?.textContent).toBe("deploy");
    await click(one().querySelector(".ac-back") as HTMLElement);
    await settle(6);

    await click(footer("enviar um .zip"));
    dialog = screen().getByRole("dialog", { name: "Enviar um .zip" });
    // What the .zip holds, nothing about its scripts: they can run on the agent's computer, as its page says.
    expect(within(dialog).getByText(/^Um \.zip/).textContent).toStartWith(
      "Um .zip com a pasta de uma skill, ou de várias, até 56 MB.",
    );
    expect(within(dialog).getByText(/^Um \.zip/).textContent).not.toContain("script");
    expect(dialog.querySelector('input[type="file"]')?.className).toContain("ac-visually-hidden");
    const file = new File([new Uint8Array([80, 75, 3, 4])], "suporte.zip", { type: "application/zip" });
    await act(async () => {
      fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    });
    expect(dialog.textContent).toContain("suporte.zip");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(8);
    const zip = calls(state, "skills.import").at(-1)?.[0] as { zipBase64: string };
    expect(zip.zipBase64).toBe(btoa(String.fromCharCode(80, 75, 3, 4)));
    expect(one().querySelector("h1")?.textContent).toBe("Skill enviada");
  });

  test("Enviar um .zip of several skills lists them to pick; the ones picked install, the .zip sent again with them", async () => {
    const { state } = await page();
    await click(footer("enviar um .zip"));
    const dialog = screen().getByRole("dialog", { name: "Enviar um .zip" });
    const file = new File([SEVERAL_SKILLS], "kit.zip", { type: "application/zip" });
    await act(async () => {
      fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    });
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(8);
    // Nothing installed yet: the .zip's skills, as a link's.
    expect(dialog.textContent).toContain("Este .zip tem 3 skills. Escolha quais instalar.");
    expect(dialog.textContent).toContain("Revisa um pull request.");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    expect(dialog.textContent).toContain("Escolha pelo menos uma skill.");
    expect(calls(state, "skills.importPickedZip")).toEqual([]);
    await click(within(dialog).getByRole("checkbox", { name: /^review/ }));
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(8);
    expect(calls(state, "skills.importPickedZip")).toEqual([[["skills/review"]]]);
    expect(one().querySelector("h1")?.textContent).toBe("review");
  });

  test("a repository holding several skills lists them to pick; GitHub's refusals in words; they join its line", async () => {
    const { state } = await page();
    await click(footer("Trazer de um link do GitHub"));
    const dialog = screen().getByRole("dialog", { name: "Trazer de um link do GitHub" });
    const link = within(dialog).getByRole("textbox", { name: "Link do GitHub" });
    await type(link, "https://github.com/acme/secret");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(dialog.textContent).toContain("acme/secret parece privado ou não existe.");

    await type(link, "https://github.com/acme/skills");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    // Nothing installed yet: each skill by name and what it is for, and the one that can't be installed with why.
    expect(dialog.textContent).toContain("Este link tem 4 skills. Escolha quais instalar.");
    expect(dialog.textContent).toContain("Revisa um pull request.");
    const skipped = within(dialog).getByRole("checkbox", { name: /claude-api/ });
    expect(skipped.hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).toContain("Não dá para instalar. A descrição precisa ter de 1 a 1024 caracteres.");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    expect(dialog.textContent).toContain("Escolha pelo menos uma skill.");
    await click(within(dialog).getByRole("checkbox", { name: /deploy/ }));
    await click(within(dialog).getByRole("checkbox", { name: /triage/ }));
    expect(within(dialog).getByRole("checkbox", { name: "Todas" }).getAttribute("aria-checked")).toBe("mixed");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(8);
    expect(calls(state, "skills.importPicked")).toEqual([
      ["https://github.com/acme/skills", ["skills/deploy", "skills/triage"]],
    ]);
    expect(screen().getByText("2 skills instaladas.")).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Trazer de um link do GitHub" })).toBeNull();
    // With Revisão de PR, from the same repository: one line.
    const repo = within(list()).getByRole("button", { name: "acme/skills" });
    expect(repo.closest(".sk-row")?.textContent).toContain("3 skills");
  });
});

describe("installing from GitHub: private repositories", () => {
  const CONTOSO = "https://github.com/contoso/skills";
  const repos = {
    connected: true,
    accounts: [
      {
        login: "contoso",
        type: "Organization",
        repositories: [
          { fullName: "contoso/skills", owner: "contoso", name: "skills", private: true, updatedAt: null },
          { fullName: "contoso/site", owner: "contoso", name: "site", private: false, updatedAt: null },
        ],
      },
    ],
    truncated: false,
  };
  const openInstall = async (state = seedState()) => {
    await page("", state);
    await click(footer("Trazer de um link do GitHub"));
    await settle(4);
    return { state, dialog: () => screen().getByRole("dialog", { name: "Trazer de um link do GitHub" }) };
  };
  const install = async (dialog: HTMLElement, url: string) => {
    await type(within(dialog).getByRole("textbox", { name: "Link do GitHub" }), url);
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
  };

  /** After connecting GitHub, as from Connectors: its confirmation, then under Adjust what it does and who uses it. */
  const finishConnecting = async () => {
    await click(
      within(screen().getByRole("dialog", { name: "GitHub conectado" })).getByRole("button", { name: "Ajustar" }),
    );
    await settle(4);
    await click(
      within(screen().getByRole("dialog", { name: "O que GitHub faz" })).getByRole("button", { name: "Continuar" }),
    );
    await settle(6);
    await click(
      within(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).getByRole("button", { name: "Liberar" }),
    );
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Quem pode usar GitHub" })).toBeNull();
  };

  test("none of the workspace's GitHub reads it: Conectar o GitHub, the link read again once connected, then what GitHub does and who uses it", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const state = seedState();
    state.connections = [];
    const { dialog } = await openInstall(state);
    await install(dialog(), CONTOSO);
    expect(dialog().textContent).toContain(
      "contoso/skills parece privado ou não existe. Conecte o GitHub para ler repositórios privados.",
    );
    // Said once, in the dialog: no toast repeating it in other words.
    expect(document.body.textContent).not.toContain("é privado ou não existe no GitHub");
    await click(within(dialog()).getByRole("button", { name: "Conectar o GitHub" }));
    await settle(2);
    const flow = () => screen().getByRole("dialog", { name: "Conectar GitHub" });
    // Signing in on GitHub comes back to Skills with the link, not to Connectors.
    await click(within(flow()).getByRole("button", { name: "Continuar no GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args[2]).toEqual({
      returnTo: `/org/${ORG_ID}/skills?install=${encodeURIComponent(CONTOSO)}`,
      serverUrl: undefined,
    });
    expect(left[0]).toStartWith("https://github.com/login/oauth/authorize");

    // A token instead: connected in place and the link read again to pick, while the flow goes on to its tools and
    // who uses them, as from Connectors.
    state.githubRepos = repos;
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_fake_token_for_tests");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(8);
    expect(calls(state, "skills.import").at(-1)?.[0]).toEqual({ url: CONTOSO, list: true });
    await finishConnecting();
    expect(dialog().textContent).toContain("Lido pela conexão do GitHub do workspace.");
    expect(dialog().textContent).toContain("Este link tem 4 skills. Escolha quais instalar.");
    // GitHub's own mark leads the line.
    expect(dialog().querySelector(".skill-via .connector-icon__mark")).not.toBeNull();
    // What the new connection reaches shows at once: another link offers to pick from it.
    await type(within(dialog()).getByRole("textbox", { name: "Link do GitHub" }), "https://github.com/acme/skills");
    await settle(4);
    expect(within(dialog()).getByRole("button", { name: "Escolher do GitHub conectado" })).toBeTruthy();
  });

  test("someone who may install skills but not manage connectors is told whom to ask, GitHub connected or not", async () => {
    const asMember = () => {
      const state = seedState();
      const me = state.me?.organizations[0];
      if (me) Object.assign(me, { role: "member", permissions: ["read", "manage_agents"] });
      return state;
    };
    const none = asMember();
    none.connections = [];
    const { dialog } = await openInstall(none);
    await install(dialog(), CONTOSO);
    expect(dialog().textContent).toContain(
      "contoso/skills parece privado ou não existe. Peça a quem administra os conectores para conectar o GitHub.",
    );
    expect(within(dialog()).queryByRole("button", { name: "Conectar o GitHub" })).toBeNull();
    cleanup();

    // GitHub connected, and it can't see the repository: access is given on GitHub, by whoever runs the connectors.
    const { dialog: again } = await openInstall(asMember());
    await install(again(), "https://github.com/acme/secret");
    expect(again().textContent).toContain(
      "acme/secret parece privado ou não existe. O GitHub conectado também não chega a ele. Peça a quem administra os conectores para liberar o acesso.",
    );
    expect(within(again()).queryByRole("button", { name: "Conectar o GitHub" })).toBeNull();
  });

  test("a connection GitHub refuses offers to connect it again; one that works and can't see the repository, to give it access", async () => {
    const state = seedState();
    state.refusedGithub = "conn-gh";
    const { dialog } = await openInstall(state);
    await install(dialog(), CONTOSO);
    expect(dialog().textContent).toContain(
      "contoso/skills parece privado ou não existe. O GitHub recusou a conexão do workspace. Conecte o GitHub de novo.",
    );
    await click(within(dialog()).getByRole("button", { name: "Conectar o GitHub" }));
    await settle(2);
    // Connecting again keeps what the agents have.
    expect(screen().getByRole("dialog", { name: "Conectar GitHub" }).textContent).toContain(
      "Substitui o login atual. Quem usa continua igual.",
    );
    cleanup();

    const { dialog: again } = await openInstall();
    await install(again(), "https://github.com/acme/secret");
    expect(again().textContent).toContain(
      "acme/secret parece privado ou não existe. O GitHub conectado também não chega a ele. Libere o acesso no GitHub para a conta conectada.",
    );
    expect(within(again()).queryByRole("button", { name: "Conectar o GitHub" })).toBeNull();
  });

  test("Escolher do GitHub conectado: a search over its repositories, the skills of the one picked, then Install", async () => {
    const state = seedState();
    state.githubRepos = repos;
    const { dialog } = await openInstall(state);
    await click(within(dialog()).getByRole("button", { name: "Escolher do GitHub conectado" }));
    await settle(4);
    await type(within(dialog()).getByRole("searchbox", { name: "Buscar repositório" }), "sk");
    const rows = within(dialog())
      .getAllByRole("button")
      .filter((b) => b.classList.contains("ac-row"));
    expect(rows.map((r) => r.textContent)).toEqual(["contoso/skillsPrivado"]);
    await click(rows[0] as HTMLElement);
    await settle(6);
    expect(calls(state, "skills.import")[0]?.[0]).toEqual({ url: CONTOSO, list: true });
    expect((within(dialog()).getByRole("textbox", { name: "Link do GitHub" }) as HTMLInputElement).value).toBe(CONTOSO);
    expect(dialog().textContent).toContain("Lido pela conexão do GitHub do workspace.");
    await click(within(dialog()).getByRole("checkbox", { name: /deploy/ }));
    await click(within(dialog()).getByRole("button", { name: "Instalar" }));
    await settle(8);
    expect(calls(state, "skills.importPicked")).toEqual([[CONTOSO, ["skills/deploy"]]]);
    // Its page opens.
    expect(one().querySelector("h1")?.textContent).toBe("deploy");

    // A token GitHub no longer takes: updating says it as installing does, once.
    state.refusedGithub = "conn-gh";
    await fromMenu(one(), "Atualizar do link");
    expect(document.body.textContent).toContain(
      "contoso/skills parece privado ou não existe. O GitHub recusou a conexão do workspace. Conecte o GitHub de novo.",
    );
    expect(document.body.textContent).not.toContain("é privado ou não existe no GitHub");

    // Disconnected: updating says the connection that read it is gone.
    state.connections = [];
    await fromMenu(one(), "Atualizar do link");
    expect(document.body.textContent).toContain(
      "A conexão do GitHub que lia contoso/skills não existe mais. Conecte o GitHub de novo para atualizar esta skill.",
    );
  });

  test("back from signing in on GitHub (`?install=`): the dialog opens on the link, reads it to pick, and the flow goes on", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const folder = `${CONTOSO}/tree/main/skills/deploy`;
    // As development runs it, every effect twice: the link is read once and stays in its field.
    await renderApp(`/org/${ORG_ID}/skills?install=${encodeURIComponent(folder)}&connected=github`, {
      api,
      strict: true,
    });
    await settle(8);
    expect(calls(state, "skills.import").map((c) => c[0])).toEqual([{ url: folder, list: true }]);
    // Signing in ends where connecting with a key does: GitHub's confirmation.
    await finishConnecting();
    const dialog = screen().getByRole("dialog", { name: "Trazer de um link do GitHub" });
    expect((within(dialog).getByRole("textbox", { name: "Link do GitHub" }) as HTMLInputElement).value).toBe(folder);
    // A folder's one skill, to check before it installs.
    expect(dialog.textContent).toContain("Lido pela conexão do GitHub do workspace.");
    expect(dialog.textContent).toContain("Este link tem 1 skill. Marque para instalar.");
    expect(state.calls.some((c) => c.method === "skills.importPicked")).toBe(false);
  });

  test("back with the agent whose card opened it: its box again, only when this tab opened that card", async () => {
    const folder = `${CONTOSO}/tree/main/skills/deploy`;
    const back = `/org/${ORG_ID}/skills?install=${encodeURIComponent(folder)}&agent=${ADA_ID}`;
    const box = () =>
      within(screen().getByRole("dialog", { name: "Trazer de um link do GitHub" })).queryByRole("checkbox", {
        name: "Fica ligada para Ada",
      });
    sessionStorage.removeItem("agentes.skills.installFor");
    await renderApp(back, { api: createFakeApi(seedState()) });
    await settle(8);
    // A link to Skills that only names an agent turns nothing on for it.
    expect(box()).toBeNull();
    cleanup();
    sessionStorage.setItem("agentes.skills.installFor", JSON.stringify({ url: folder, agentId: ADA_ID }));
    await renderApp(back, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(box()?.getAttribute("aria-checked")).toBe("true");
    expect(sessionStorage.getItem("agentes.skills.installFor")).toBeNull();
  });
});

describe("agent skills", () => {
  test("the Skills tab: what it knows and how often, what it could learn; each change at once, with Desfazer", async () => {
    const { state, api, review, care } = await seeded();
    const { router } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=skills`, { api });
    await settle(8);
    const card = () => screen().getByRole("region", { name: "O que a Ada sabe fazer" });
    const knows = () =>
      [...card().querySelectorAll(".sk-arows:not(.sk-arows--offer) .sk-row__link")].map((a) => a.textContent);
    expect(knows()).toEqual(["Revisão de PR"]);
    expect(card().querySelector(".sk-arow")?.textContent).toContain("12 vezes esta semana");
    // Atendimento, from its week: Teach turns it on.
    const offer = card().querySelector(".sk-arows--offer .sk-arow") as HTMLElement;
    expect(offer.textContent).toContain("Atendimento");
    expect(offer.textContent).toContain("Pedidos assim chegaram 3 vezes esta semana.");
    await click(within(offer).getByRole("button", { name: "Ensinar" }));
    await settle(6);
    expect(calls(state, "skills.setForAgent")).toEqual([[ADA_ID, [{ skillId: care.id, enabled: true }]]]);
    expect(screen().getByText("A Ada agora sabe Atendimento.")).toBeTruthy();
    expect(knows()).toEqual(["Revisão de PR", "Atendimento"]);
    expect(card().querySelector(".sk-arows--offer")).toBeNull();

    // Taken away from its "…", and Undo gives it back.
    const first = card().querySelector(".sk-arow") as HTMLElement;
    await fromMenu(first, "Tirar da Ada");
    expect(calls(state, "skills.setForAgent").at(-1)).toEqual([ADA_ID, [{ skillId: review.id, enabled: false }]]);
    expect(knows()).toEqual(["Atendimento"]);
    const toast = screen().getByText("A Ada não sabe mais Revisão de PR.").closest(".ac-toast") as HTMLElement;
    await click(within(toast).getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(calls(state, "skills.setForAgent").at(-1)).toEqual([ADA_ID, [{ skillId: review.id, enabled: true }]]);

    await click(within(card()).getByRole("switch", { name: "Aprende sozinha" }));
    await settle(4);
    expect(calls(state, "skills.setLearns")).toEqual([[ADA_ID, false]]);

    // Teach opens Skills for her.
    await click(within(card().querySelector(".ac-card__head") as HTMLElement).getByRole("button", { name: "Ensinar" }));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/skills`);
    expect(router.state.location.search).toEqual({ for: ADA_ID });
  });

  test("Skills for one agent: what it already knows, and Ensinar for the rest", async () => {
    const { state, api, weekly } = await seeded();
    await page(`?for=${ADA_ID}`, state, api);
    expect(skillsPage().textContent).toContain("O que a Ada sabe, e o que o time pode ensinar a ela.");
    expect(within(skillsPage()).getByRole("combobox", { name: "Para" }).textContent).toContain("Ada");
    expect(row("Revisão de PR").textContent).toContain("Já sabe");
    await click(within(row("Relatório semanal")).getByRole("button", { name: "Ensinar" }));
    await settle(6);
    expect(calls(state, "skills.setForAgent")).toEqual([[ADA_ID, [{ skillId: weekly.id, enabled: true }]]]);
    expect(screen().getByText("A Ada agora sabe Relatório semanal.")).toBeTruthy();
    expect(row("Relatório semanal").textContent).toContain("Já sabe");
  });

  test("Criar agente: optional Skills under the tools, the ones on for new agents already checked", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(state) });
    await settle(8);
    await startAs("QA");
    await proceed(2);
    const step = screen().getByRole("region", { name: /^Skills/ });
    // Three skills: no search.
    expect(within(step).queryByRole("searchbox")).toBeNull();
    // "Ligar em agentes novos" skills start checked.
    expect(
      within(step)
        .getByRole("checkbox", { name: /Relatório semanal/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(step).getByRole("checkbox", { name: /Atendimento/ }));
    expect(screen().getByRole("complementary", { name: "Prévia do agente" }).textContent).toContain("Atendimento");
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const sent = state.calls.find((c) => c.method === "skills.setForAgent")?.args[2] as {
      skillId: string;
      enabled: boolean;
    }[];
    expect(sent.filter((x) => x.enabled)).toHaveLength(2);
  });

  test("Criar agente › Instalar skill: every way in as a tab, and Escrever makes one, checked for the new agent", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(state) });
    await settle(8);
    await startAs("QA");
    await proceed(2);
    await click(
      within(screen().getByRole("region", { name: /^Skills/ })).getByRole("button", { name: "Instalar skill" }),
    );
    const dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    expect(
      within(dialog)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Link do GitHub", "Enviar .zip", "Escrever"]);
    await pickTab(within(dialog).getByRole("tab", { name: "Escrever" }));
    await type(within(dialog).getByLabelText("Nome"), "Deploy seguro");
    await type(within(dialog).getByLabelText("Quando usar"), "Antes de qualquer deploy.");
    await type(within(dialog).getByLabelText("Instruções (Markdown)"), "# Deploy\n\n1. Confira o CI.");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(8);
    expect(calls(state, "skills.create")[0]?.[0]).toMatchObject({ name: "Deploy seguro" });
    expect(
      within(screen().getByRole("region", { name: /^Skills/ }))
        .getByRole("checkbox", { name: /Deploy seguro/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("activity bar: load_skill", () => {
  test("names the skill when it can; otherwise 'consultando uma skill'", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    expect(toolActivity("load_skill", null, "Revisão de PR")).toEqual({ kind: "openingSkill", app: "Revisão de PR" });
    expect(toolActivity("load_skill")).toEqual({ kind: "consultingSkill" });
    expect(
      activityText(t, [
        { id: "a", type: "agent", name: "Theo", activity: toolActivity("load_skill", null, "Revisão de PR") },
      ]),
    ).toBe("Theo está abrindo a skill Revisão de PR…");
    expect(activityText(t, [{ id: "a", type: "agent", name: "Theo", activity: toolActivity("load_skill") }])).toBe(
      "Theo está consultando uma skill…",
    );
  });
});
