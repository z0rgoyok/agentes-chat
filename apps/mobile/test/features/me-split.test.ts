import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ME_FALLBACK, ME_PAGES, meSplit } from "../../src/features/me/split";
import { hrefOfRoute } from "../../src/features/shared/split-store";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");
const MAIN = join(import.meta.dir, "../../app/(app)/(main)");

describe("Você in two panes (ADR 0212)", () => {
  test("its own pages, each a route of its own; Notificações while none is chosen, never pushed when it closes", () => {
    for (const page of ME_PAGES)
      expect({ page, route: existsSync(join(MAIN, `${page.slice(1)}.tsx`)) }).toEqual({ page, route: true });
    expect(ME_PAGES).toContain(ME_FALLBACK);
    expect(ME_FALLBACK).toBe("/me/notifications");
    // The workspaces, its settings, agents and work keep being pushed.
    for (const other of ["/me/workspaces", "/settings", "/issues", "/drive", "/team", "/me/members"])
      expect(ME_PAGES as readonly string[]).not.toContain(other);
    // A page pushed right over Você is taken back by its route's address.
    expect(hrefOfRoute({ name: "me/language" })).toBe("/me/language");
    meSplit.offer("org-me-a", ME_FALLBACK);
    expect(meSplit.shown("org-me-a")).toBe("/me/notifications");
    expect(meSplit.chosen("org-me-a")).toBeNull();
  });

  test("wide, the list and the chosen page side by side, each drawn as its route draws it", () => {
    const me = src("me/MeScreen.tsx");
    expect(me).toMatch(
      /<PageSplitScreen\s+store=\{meSplit\}\s+pages=\{ME_PAGE_VIEWS\}\s+fallback=\{ME_FALLBACK\}\s+list=\{<MePage \/>\}\s+testID="me-split"/,
    );
    // Every page has its view: what its route renders.
    expect(me).toContain("} satisfies SplitPages & Record<MePageHref, () => ReactNode>;");
    for (const page of ME_PAGES) {
      const route = readFileSync(join(MAIN, `${page.slice(1)}.tsx`), "utf8");
      const view = /return <(\w+) \/>;/.exec(route)?.[1];
      expect({ page, view: me.includes(`"${page}": () => <${view} />,`) }).toEqual({ page, view: true });
    }
  });

  test("its page rows open beside the list and stay lit; Editar opens Conta there; the rest is pushed", () => {
    const me = src("me/MeScreen.tsx");
    expect(me).toContain("const open = useOpenPage();");
    expect(me).toContain("const lit = useLitPage();");
    for (const page of ME_PAGES.filter((p) => p !== "/me/account" && p !== "/me/status"))
      expect(me.replace(/\s+/g, " ")).toContain(`{...lit("${page}")} chevron onPress={() => open("${page}")}`);
    expect(me).toContain(
      '<GroupedRow icon="smile" label={label} {...lit("/me/status")} chevron onPress={() => open("/me/status")} />',
    );
    expect(me).toContain('action={{ label: t("mobile.me.edit"), onPress: () => open("/me/account"), opens: true }}');
    // An agent of yours is pushed, never a page of Você's.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the screen's source
    expect(me).toContain("onPress={() => pushScreen(`/agent/${agentId}`)}");
    expect(src("shared/SplitPanes.tsx")).toContain("if (!opener?.open(href)) router.push(href as never);");
  });
});
