import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys, type StoragePlatform } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, fakeMachinesOf, ORG_ID, seedState, withRightHand } from "./fake-api";
import { createMockStorage } from "./fakes/storage";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state = seedState()) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
  await settle(5);
  return { api, r };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const section = () => screen().getByRole("region", { name: "Armazenamento" });
/** Text as read, no-break spaces as spaces. */
const text = (el: Element | null | undefined) => el?.textContent?.replaceAll("\u00a0", " ");
/** An option's lines under its title: its words, then what its files take where it is the one in use. */
const linesOf = (option: Element | null | undefined) =>
  [...(option?.closest("label")?.querySelectorAll(".ac-option__desc") ?? [])].map(text);
const GB = 1024 ** 3;
// Query timers don't run under the test DOM (TanStack sees no window at import): poll by hand.
type Rendered = Awaited<ReturnType<typeof go>>["r"];
const poll = async (r: Rendered, times: number) => {
  for (let i = 0; i < times; i++) {
    await act(() => r.services.queryClient.refetchQueries({ queryKey: keys.storageMigration(ORG_ID) }));
    await settle(2);
  }
};

const ownStorage = () => within(section()).getByRole("radio", { name: /Seu próprio armazenamento/ });
const dialog = (name?: string) => screen().getByRole("dialog", name ? { name } : {});
const footer = (name: string) => within(dialog()).getByRole("button", { name });
const fieldLabels = () => [...dialog().querySelectorAll(".ac-field__label")].map((l) => l.textContent);
const openConnect = async () => {
  await click(ownStorage());
  await click(within(section()).getByRole("button", { name: "Conectar um armazenamento" }));
  await settle(2);
};
const pick = async (service: string) => {
  await click(within(dialog()).getByRole("button", { name: new RegExp(service) }));
  await settle(2);
};
const R2_ENDPOINT = "https://4f1c0a7e.r2.cloudflarestorage.com";
const fillR2 = async (bucket: string) => {
  const d = within(dialog());
  await type(d.getByLabelText("Nome do bucket"), bucket);
  await type(d.getByLabelText("ID da chave de acesso"), "AKIAEXAMPLE1234");
  await type(d.getByLabelText("Chave de acesso secreta"), "secret-value-9876");
  await type(d.getByLabelText("Endereço do R2"), R2_ENDPOINT);
};
const testConnection = async (name = "Testar conexão") => {
  await click(footer(name));
  await settle(4);
};
/** "Connect storage" → Cloudflare R2 → the fields → test → Activate. */
const connectR2 = async (bucket: string) => {
  await openConnect();
  await pick("Cloudflare R2");
  await fillR2(bucket);
  await testConnection();
  await click(footer("Ativar"));
  await settle(4);
};

describe("Configurações → Armazenamento", () => {
  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(screen().queryByRole("region", { name: "Armazenamento" })).toBeNull();
  });

  test("on a server people run, files stay on this server: its disk, the folder, its database or its bucket", async () => {
    await go();
    const s = section();
    const server = within(s).getByRole("radio", { name: /Este servidor/ });
    expect(server.getAttribute("aria-checked")).toBe("true");
    // The page's title names the card, so the choices come first, and the radio alone says which is in use.
    expect(s.querySelector("h2, h3")).toBeNull();
    expect(s.textContent?.indexOf("Este servidor")).toBe(0);
    expect(text(server.closest("label"))).toBe("Este servidorOs arquivos ficam no disco dele.Nenhum arquivo");
    // Our storage is the Cloud's: never said where the server is someone's own.
    expect(s.textContent).not.toMatch(/nosso armazenamento|Armazenamento do agentes/);
    // No native Google Drive or OneDrive is coming (they connect through Conectores): never promised here.
    expect(
      within(s)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toEqual(["agentes", "s3"]);
    expect(s.textContent).not.toMatch(/Google Drive|OneDrive|Em breve/);
    expect(within(s).queryByLabelText("Endpoint")).toBeNull();

    const line = async (platform: StoragePlatform) => {
      cleanup();
      await go(seedState({ storagePlatform: platform }));
      return within(section())
        .getByRole("radio", { name: /Este servidor/ })
        .closest("label") as HTMLElement;
    };
    expect((await line({ kind: "database", folder: null })).textContent).toContain(
      "Os arquivos ficam no banco de dados dele.",
    );
    expect((await line({ kind: "bucket", folder: null })).textContent).toContain(
      "Os arquivos ficam no bucket configurado para ele.",
    );
    const folder = await line({ kind: "disk", folder: "/Users/walter/.agentes/files" });
    expect(folder.textContent).toContain("Os arquivos ficam em /Users/walter/.agentes/files.");
    expect(folder.querySelector("code")?.textContent).toBe("/Users/walter/.agentes/files");
    // Show the folder is the desktop app's, on its own server: never in a browser.
    expect(within(section()).queryByRole("button", { name: "Mostrar a pasta" })).toBeNull();
  });

  test("on the Cloud, agentes storage keeps its words", async () => {
    const api = createFakeApi(seedState());
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    const ours = within(section()).getByRole("radio", { name: /Armazenamento do agentes/ });
    expect(ours.getAttribute("aria-checked")).toBe("true");
    expect(text(ours.closest("label"))).toBe(
      "Armazenamento do agentes.chatSeus arquivos ficam no nosso armazenamento, separados por workspace.Nenhum arquivo",
    );
    expect(section().textContent).not.toContain("Este servidor");
  });

  test("the workspace computer's disk: a bar by what takes it, each kind named with its amount, then what is free", async () => {
    const api = createFakeApi(withRightHand(seedState()));
    const machines = fakeMachinesOf.get(api);
    const parts = { projects: 40, apps: 15, agents: 60, caches: 12.5, system: 0 };
    machines?.setSetup({ state: "ready", machineId: "machine_1" });
    const m = machines?.pair({
      name: "Computador da Acme",
      kind: "managed",
      os: "other",
      disk: { freeGb: 50, use: 0.75, sharedGb: 2, sizeGb: 200, parts },
    });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    const card = screen().getByRole("region", { name: "Computador do workspace" });
    expect(text(card.querySelector(".ac-card__head"))).toContain("150 GB de 200 GB em uso");
    const bar = within(card).getByRole("meter", { name: "Disco do computador do workspace" });
    // A kind that takes nothing draws nothing; what no kind covers is Other, its piece last.
    expect(bar.querySelectorAll(".ac-meter__seg")).toHaveLength(5);
    expect([...card.querySelectorAll(".plan-legend__item")].map(text)).toEqual([
      "Projetos e código 40 GB",
      "Apps e ferramentas 15 GB",
      "Arquivos dos agentes 60 GB",
      "Caches e temporários 13 GB",
      "Outros 23 GB",
      "Livre 50 GB",
    ]);
    // Room to spare: no warning.
    expect(card.querySelector(".ac-setnote")).toBeNull();

    // Filling up: what is left and the way out, an agent asked to clear caches.
    cleanup();
    if (m) machines?.patch(m.id, { disk: { freeGb: 16, use: 0.92, sharedGb: 2, sizeGb: 200, parts } });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    const full = screen().getByRole("region", { name: "Computador do workspace" });
    expect(text(full.querySelector(".ac-setnote"))).toBe(
      "Quase cheio, restam 16 GB. Um agente pode limpar caches e arquivos temporários e apagar o que ninguém usa mais.",
    );
    await click(within(full).getByRole("button", { name: "Peça ao Lodi" }));
    await settle(4);
    expect(document.body.textContent).toContain(
      "Libere espaço no computador do workspace: limpe caches e arquivos temporários",
    );
  });

  test("the workspace computer before it measured its disk: its use, and that what takes it is being measured", async () => {
    const api = createFakeApi(seedState());
    fakeMachinesOf.get(api)?.pair({
      name: "Computador da Acme",
      kind: "managed",
      os: "other",
      disk: { freeGb: 150, use: 0.25, sharedGb: null },
    });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    const card = screen().getByRole("region", { name: "Computador do workspace" });
    expect(text(card)).toContain("50 GB de 200 GB em uso");
    expect(text(card)).toContain("Medindo o que ocupa o espaço.");
    expect(card.querySelectorAll(".ac-meter__seg")).toHaveLength(0);
  });

  test("the option in use says what its files take: on this server's disk with what is free, in its database or bucket, on the Cloud", async () => {
    const lines = async (state: Partial<FakeState>, options: { cloud?: boolean; en?: boolean } = {}) => {
      cleanup();
      const api = createFakeApi(seedState(state));
      if (options.cloud) fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
      const { services } = await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
      await settle(5);
      if (options.en) {
        await act(async () => {
          await services.i18n.changeLanguage("en");
        });
        await settle(3);
      }
      return linesOf(document.querySelector('label.ac-option[data-state="checked"]'));
    };
    const disk = { platformBytes: 2.4 * GB, ownBucketBytes: 0, disk: { sizeBytes: 256 * GB, freeBytes: 38 * GB } };
    expect(await lines({ storageUsage: disk })).toEqual([
      "Os arquivos ficam no disco dele.",
      "2,4 GB de arquivos · 38 GB livres no disco",
    ]);
    expect(await lines({ storageUsage: disk }, { en: true })).toEqual([
      "Files stay on its disk.",
      "2.4 GB of files · 38 GB free on disk",
    ]);
    // The desktop app's folder: nothing there yet, on a big disk.
    const folder: StoragePlatform = { kind: "disk", folder: "/Users/walter/.agentes/files" };
    const empty = { platformBytes: 0, ownBucketBytes: 0, disk: { sizeBytes: 2048 * GB, freeBytes: 1.5 * 1024 * GB } };
    expect((await lines({ storagePlatform: folder, storageUsage: empty }))[1]).toBe(
      "Nenhum arquivo · 1,5 TB livres no disco",
    );
    // A database or a bucket says what it holds, with no disk of the server's to tell.
    const held = (platformBytes: number) => ({ platformBytes, ownBucketBytes: 0, disk: null });
    expect(
      await lines({ storagePlatform: { kind: "database", folder: null }, storageUsage: held(300 * 1024 ** 2) }),
    ).toEqual(["Os arquivos ficam no banco de dados dele.", "300 MB de arquivos"]);
    expect(await lines({ storagePlatform: { kind: "bucket", folder: null }, storageUsage: held(12 * GB) })).toEqual([
      "Os arquivos ficam no bucket configurado para ele.",
      "12 GB de arquivos",
    ]);
    expect(
      await lines({ storagePlatform: { kind: "bucket", folder: null }, storageUsage: held(3.2 * GB) }, { cloud: true }),
    ).toEqual(["Seus arquivos ficam no nosso armazenamento, separados por workspace.", "3,2 GB de arquivos"]);
    expect(
      await lines(
        { storagePlatform: { kind: "bucket", folder: null }, storageUsage: held(3.2 * GB) },
        { cloud: true, en: true },
      ),
    ).toEqual(["Your files stay in our storage, kept apart per workspace.", "3.2 GB of files"]);
    // The Cloud keeps them on its own disk too, which every workspace there shares: its server sends no disk, so the
    // line is the workspace's files alone.
    const cloudDisk = { storagePlatform: { kind: "disk", folder: null } as StoragePlatform, storageUsage: held(0) };
    expect((await lines(cloudDisk, { cloud: true }))[1]).toBe("Nenhum arquivo");
    expect((await lines(cloudDisk, { cloud: true, en: true }))[1]).toBe("No files");
  });

  test("under a storage limit the meter says what the files take, and the option in use doesn't say it again", async () => {
    const api = createFakeApi(
      seedState({
        storagePlatform: { kind: "bucket", folder: null },
        storageUsage: { platformBytes: 3.2 * GB, ownBucketBytes: 0, disk: null },
        limits: {
          members: { used: 2, limit: null },
          storage: { usedBytes: 3.2 * GB, limitBytes: 50 * GB, ownStorage: false },
          uploads: { usedBytes24h: 0, limitBytesPerDay: null },
        },
      }),
    );
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    expect(text(section())).toContain("Vocês usaram 3,2 GB de 50 GB.");
    expect(linesOf(document.querySelector('label.ac-option[data-state="checked"]'))).toEqual([
      "Seus arquivos ficam no nosso armazenamento, separados por workspace.",
    ]);
  });

  test("on its own storage, that option says its service, bucket and what it holds; picked and not saved, the line stays put", async () => {
    await go(
      seedState({
        storageUsage: {
          platformBytes: 2 * GB,
          ownBucketBytes: 1.2 * GB,
          disk: { sizeBytes: 100 * GB, freeBytes: 40 * GB },
        },
      }),
    );
    const server = () => within(section()).getByRole("radio", { name: /Este servidor/ });
    await click(ownStorage());
    expect(linesOf(server())).toEqual(["Os arquivos ficam no disco dele.", "2 GB de arquivos · 40 GB livres no disco"]);
    expect(linesOf(ownStorage())).toEqual(["Cloudflare R2, Amazon S3, Backblaze B2 ou outro compatível com S3."]);
    // Picked, it offers the dialog: none of the bucket's fields on the page.
    expect(within(section()).queryByLabelText("Endpoint")).toBeNull();
    await connectR2("acme-arquivos");
    expect(linesOf(ownStorage())).toEqual(["Cloudflare R2 · acme-arquivos", "1,2 GB de arquivos"]);
    expect(linesOf(server())).toEqual(["Os arquivos ficam no disco dele."]);
  });

  test("Show the folder: in the desktop app on its own server, once the app opens it", async () => {
    const win = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    const asked: Record<string, unknown>[] = [];
    const app = (flags: Record<string, unknown>, local: boolean) => {
      win.__agentesDesktop = { version: "0.6.0", ...flags };
      win.__TAURI_INTERNALS__ = {
        invoke: async (_cmd: string, args: { request: Record<string, unknown> }) => {
          asked.push(args.request);
          return args.request.kind === "status" ? { orgs: [], local } : {};
        },
      };
    };
    const show = async (platform: StoragePlatform) => {
      cleanup();
      await go(seedState({ storagePlatform: platform }));
      return within(section()).queryByRole("button", { name: "Mostrar a pasta" });
    };
    const folder: StoragePlatform = { kind: "disk", folder: "/Users/walter/.agentes/files" };
    try {
      // An app from before it could: nothing.
      app({}, true);
      expect(await show(folder)).toBeNull();
      // Another server's page in the app: nothing.
      app({ files: true }, false);
      expect(await show(folder)).toBeNull();
      // Its own server, keeping files in a database: no folder to show.
      app({ files: true }, true);
      expect(await show({ kind: "database", folder: null })).toBeNull();
      const button = await show(folder);
      // Under the options: an option is a label, which can't hold a button.
      expect(button?.closest("label")).toBeNull();
      expect(button?.parentElement?.previousElementSibling?.getAttribute("role")).toBe("radiogroup");
      await click(button as HTMLElement);
      expect(asked.at(-1)).toEqual({ kind: "files" });
    } finally {
      delete win.__agentesDesktop;
      delete win.__TAURI_INTERNALS__;
    }
  });

  test("Connect storage lists the services; each one's steps ask only for its own fields", async () => {
    await go();
    await openConnect();
    const list = dialog("Onde fica o seu armazenamento?");
    expect([...list.querySelectorAll(".storage-pick .ac-optrow__hit")].map((n) => n.textContent)).toEqual([
      "Cloudflare R2",
      "Amazon S3",
      "Backblaze B2",
      "Outro",
    ]);
    // No native Google Drive or OneDrive is coming (they connect through Conectores): never promised here either.
    expect(list.textContent).not.toMatch(/Google Drive|OneDrive/);

    await pick("Cloudflare R2");
    expect(fieldLabels()).toEqual([
      "Nome do bucket",
      "ID da chave de acesso",
      "Chave de acesso secreta",
      "Endereço do R2",
    ]);
    // Under each field, what Cloudflare calls it; its page opens in a new tab.
    expect(dialog().textContent).toContain("No Cloudflare: Access Key ID");
    const r2 = within(dialog()).getByRole("link", { name: "Abrir o R2" });
    expect(r2.getAttribute("target")).toBe("_blank");
    expect(r2.getAttribute("href")).toStartWith("https://dash.cloudflare.com/");

    await click(footer("Voltar"));
    await pick("Amazon S3");
    expect(fieldLabels()).toEqual(["Nome do bucket", "Região", "ID da chave de acesso", "Chave de acesso secreta"]);
    // The policy waits for the bucket's name, then copies one that reaches that bucket alone.
    let clip = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (v: string) => {
          clip = v;
        },
      },
    });
    expect(within(dialog()).getByRole("button", { name: "Copiar a política" }).hasAttribute("disabled")).toBe(true);
    await type(within(dialog()).getByLabelText("Nome do bucket"), "acme-arquivos");
    await click(within(dialog()).getByRole("button", { name: "Copiar a política" }));
    await settle(2);
    expect(JSON.parse(clip).Statement[0].Resource).toBe("arn:aws:s3:::acme-arquivos");
    expect(document.body.textContent).toContain("Política copiada, com o bucket acme-arquivos.");
    // Tested with no region: it says so.
    await testConnection();
    expect(within(dialog()).getByText("Escolha a região")).toBeTruthy();
    expect(dialog().textContent).toContain("Preencha este campo.");

    await click(footer("Voltar"));
    await pick("Backblaze B2");
    // Another service is a new form: the bucket typed for Amazon S3 isn't here.
    expect((within(dialog()).getByLabelText("Nome do bucket") as HTMLInputElement).value).toBe("");
    expect(fieldLabels()).toEqual([
      "Nome do bucket",
      "Endpoint do bucket",
      "ID da chave de acesso",
      "Chave de acesso secreta",
    ]);
    expect(dialog().textContent).toContain("A chave principal da conta (master key) não funciona aqui.");

    await click(footer("Voltar"));
    await pick("Outro");
    expect(fieldLabels()).toEqual(["Endpoint", "Região", "Bucket", "Prefixo (opcional)", "Access key", "Secret"]);
    expect(within(dialog()).getByLabelText("Estilo de caminho")).toBeTruthy();
  });

  test("a failing step reads by its code with what to check there; Ativar waits for a passing test of the same settings", async () => {
    const { api } = await go();
    await click(ownStorage());
    // Until the storage is saved, the server's option says it's still the one in use, on its title's line: the
    // description under them keeps the card's whole width.
    const inUse = () =>
      [...section().querySelectorAll(".ac-option__head")].filter((h) => h.textContent?.endsWith("Em uso"));
    expect(inUse().map((h) => h.textContent)).toEqual(["Este servidorEm uso"]);
    expect(inUse()[0]?.nextElementSibling?.textContent).toBe("Os arquivos ficam no disco dele.");

    await openConnect();
    await pick("Cloudflare R2");
    expect(within(dialog()).queryByRole("button", { name: "Ativar" })).toBeNull();
    // Empty form: the test does not run, fields explain why.
    await testConnection();
    expect(dialog().textContent).toContain("Preencha este campo.");
    expect(dialog().textContent).toContain("Informe as duas chaves.");

    await fillR2("acme-negado");
    await testConnection();
    const steps = within(dialog()).getByRole("region", { name: "Resultado do teste" });
    const write = steps.querySelector('[data-step="write"]');
    expect(write?.textContent).toContain("Escrever");
    expect(write?.textContent).toContain("Falhou");
    // The reason in the person's language, by its code, never the server's English.
    expect(write?.textContent).toContain("A chave não tem permissão para esta etapa.");
    expect(write?.textContent).not.toContain("no permission");
    expect(steps.querySelector('[data-step="read"]')?.textContent).toContain("Não testado");
    expect(text(steps)).toContain(
      "No Cloudflare, confira se o token tem a permissão Object Read & Write e acesso ao bucket acme-negado.",
    );
    expect(footer("Testar de novo")).toBeTruthy();

    await type(within(dialog()).getByLabelText("Nome do bucket"), "acme-arquivos");
    expect(dialog().textContent).toContain("As configurações mudaram. Teste de novo antes de ativar.");
    await testConnection();
    expect(dialog().textContent).toContain(
      "Conexão funcionando: gravamos, lemos, listamos e apagamos um arquivo de teste.",
    );
    expect(dialog().textContent).toContain(
      "Arquivos antigos continuam onde estão. Novos arquivos vão para o seu bucket.",
    );
    expect(
      within(dialog()).queryByRole("region", { name: "Resultado do teste" })?.querySelector("[data-step]"),
    ).toBeFalsy();

    // Changing anything asks for a new test; changing it back finds the test that passed.
    await type(within(dialog()).getByLabelText("ID da chave de acesso"), "AKIAEXAMPLE1235");
    expect(within(dialog()).queryByRole("button", { name: "Ativar" })).toBeNull();
    await type(within(dialog()).getByLabelText("ID da chave de acesso"), "AKIAEXAMPLE1234");
    await click(footer("Ativar"));
    await settle(4);

    expect(screen().queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).toContain("Armazenamento trocado para o seu bucket.");
    expect(inUse()).toEqual([]);
    const config = await api.storage.get(ORG_ID);
    // What the server got: R2's endpoint, region auto and path-style, filled in by the app.
    expect(config.s3).toMatchObject({
      provider: "r2",
      endpoint: R2_ENDPOINT,
      region: "auto",
      bucket: "acme-arquivos",
      pathStyle: true,
    });
    expect(JSON.stringify(config)).not.toContain("secret-value");
    expect(document.body.textContent).not.toContain("secret-value-9876");
  });

  test("Edit connection opens the saved service's steps, the keys blank and kept until replaced", async () => {
    await go();
    await connectR2("acme-arquivos");
    await click(within(section()).getByRole("button", { name: "Editar conexão" }));
    await settle(2);
    const d = within(dialog("Editar o Cloudflare R2"));
    expect((d.getByLabelText("Nome do bucket") as HTMLInputElement).value).toBe("acme-arquivos");
    expect((d.getByLabelText("Endereço do R2") as HTMLInputElement).value).toBe(R2_ENDPOINT);
    // Keys are masked: only hints, inputs empty.
    const secret = d.getByLabelText("Chave de acesso secreta") as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.getAttribute("type")).toBe("password");
    expect(dialog().textContent).toContain("Salva, termina em 1234. Deixe em branco para manter.");
    expect(dialog().textContent).toContain("Salva, termina em 9876.");
    // Blank keys are the saved ones: the test runs without them, then the main button saves.
    await testConnection();
    expect(footer("Salvar bucket")).toBeTruthy();
    await click(footer("Cancelar"));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("storage saved before the service was said: named by its address, edited with today's fields", async () => {
    const api = createFakeApi(seedState());
    const s3 = {
      endpoint: "https://minio.acme.test",
      region: "us-east-1",
      bucket: "acme-antigo",
      prefix: null,
      pathStyle: true,
      accessKeyId: "AKOLD1111",
      secretAccessKey: "old-secret-2222",
    };
    await api.storage.test(ORG_ID, s3);
    await api.storage.save(ORG_ID, { kind: "s3", s3 });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    expect(linesOf(ownStorage())[0]).toBe("acme-antigo em minio.acme.test");
    await click(within(section()).getByRole("button", { name: "Editar conexão" }));
    await settle(2);
    expect(fieldLabels()).toEqual(["Endpoint", "Região", "Bucket", "Prefixo (opcional)", "Access key", "Secret"]);
    expect((within(dialog("Editar o armazenamento")).getByLabelText("Endpoint") as HTMLInputElement).value).toBe(
      "https://minio.acme.test",
    );
  });

  test("copy existing files shows progress, stops, resumes and finishes", async () => {
    const { r } = await go(
      seedState({
        storageUsage: { platformBytes: 2 * GB, ownBucketBytes: 0, disk: { sizeBytes: 100 * GB, freeBytes: 40 * GB } },
      }),
    );
    await connectR2("acme-instavel");
    expect(linesOf(ownStorage())).toEqual(["Cloudflare R2 · acme-instavel", "Nenhum arquivo"]);
    await click(within(section()).getByRole("button", { name: "Copiar arquivos existentes" }));
    await settle(2);
    expect(within(section()).getByRole("meter", { name: "Progresso da cópia" })).toBeTruthy();
    await poll(r, 1);
    expect(section().textContent).toContain("Copiando arquivos: 40 de 120");
    await poll(r, 1);
    expect(section().textContent).toContain("A cópia parou em 80 de 120.");
    expect(section().textContent).toContain("A conexão com o bucket caiu.");
    await click(within(section()).getByRole("button", { name: "Retomar cópia" }));
    await settle(2);
    await poll(r, 2);
    expect(section().textContent).toContain("Cópia concluída: 120 arquivos no seu bucket.");
    expect(within(section()).getByRole("meter").getAttribute("aria-valuenow")).toBe("120");
    // The bucket's card says what the copy took there, without reopening the page.
    await settle(3);
    expect(linesOf(ownStorage())).toEqual(["Cloudflare R2 · acme-instavel", "2 GB de arquivos"]);
  });

  test("switch back to this server after confirming, or to agentes storage on the Cloud", async () => {
    const back = async (cloud: boolean) => {
      cleanup();
      const api = createFakeApi(seedState());
      if (cloud) fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
      await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
      await settle(5);
      await connectR2("acme-arquivos");
      return api;
    };
    const api = await back(false);
    expect(section().textContent).toContain("Copia para o seu bucket os arquivos que este servidor ainda guarda.");
    await click(within(section()).getByRole("button", { name: "Voltar para este servidor" }));
    const dialog = screen().getByRole("dialog", { name: "Voltar para este servidor?" });
    expect(dialog.textContent).toContain(
      "Novos arquivos voltam para este servidor. O que já está no seu bucket continua lá.",
    );
    await click(within(dialog).getByRole("button", { name: "Voltar para este servidor" }));
    await settle(4);
    expect((await api.storage.get(ORG_ID)).kind).toBe("agentes");
    expect(section().textContent).not.toContain("Novos arquivos vão para o seu bucket.");
    expect(document.body.textContent).toContain("Armazenamento trocado para este servidor.");

    await back(true);
    expect(section().textContent).toContain(
      "Copia para o seu bucket os arquivos que o armazenamento do agentes.chat ainda guarda.",
    );
    await click(within(section()).getByRole("button", { name: "Voltar para o armazenamento do agentes.chat" }));
    const cloud = screen().getByRole("dialog", { name: "Voltar para o armazenamento do agentes.chat?" });
    expect(cloud.textContent).toContain("Novos arquivos voltam para o armazenamento do agentes.chat.");
  });
});

describe("storage mock", () => {
  const s3 = { endpoint: "https://r2.example", region: "auto", bucket: "b", prefix: null, pathStyle: true };
  test("activating needs a passing test of the same settings", async () => {
    const m = createMockStorage();
    await expect(m.save("o", { kind: "s3", s3 })).rejects.toThrow();
    expect((await m.test("o", { ...s3, bucket: "lista" })).steps.map((x) => x.ok)).toEqual([true, true, false, false]);
    await m.test("o", s3);
    await expect(m.save("o", { kind: "s3", s3: { ...s3, region: "x" } })).rejects.toThrow();
    expect(
      (await m.save("o", { kind: "s3", s3: { ...s3, accessKeyId: "AK12", secretAccessKey: "SSSS" } })).s3,
    ).toMatchObject({ accessKeyIdHint: "AK12", secretHint: "SSSS" });
  });
});
