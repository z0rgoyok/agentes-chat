import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render, within } from "@testing-library/react";
import {
  Button,
  PageHeader,
  Refreshing,
  SKELETON_DELAY_MS,
  Skeleton,
  SkeletonConversation,
  SkeletonGroup,
  SkeletonList,
  SwapLabel,
} from "../src";

afterEach(() => cleanup());

const body = () => within(document.body);
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("Skeleton", () => {
  test("a labelled status region; shapes are sized at once but shown only after the delay", async () => {
    render(
      <SkeletonGroup label="Carregando mensagens">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    const group = body().getByRole("status", { name: "Carregando mensagens" });
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(group.hasAttribute("data-visible")).toBe(false);
    const shape = group.querySelector(".ac-skeleton") as HTMLElement;
    expect(shape.getAttribute("aria-hidden")).toBe("true");
    // Same size before and after it shows: no layout shift.
    expect(shape.style.width).toBe("120px");
    await wait(SKELETON_DELAY_MS + 30);
    expect(group.hasAttribute("data-visible")).toBe(true);
    expect(shape.style.width).toBe("120px");
  });

  test("a skeleton taking over from one on screen (the next stage of the same load) shows at once", async () => {
    const { rerender } = render(
      <SkeletonGroup key="first" label="Carregando a página">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    await wait(SKELETON_DELAY_MS + 30);
    rerender(
      <SkeletonGroup key="next" label="Carregando mensagens">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    expect(body().getByRole("status", { name: "Carregando mensagens" }).hasAttribute("data-visible")).toBe(true);
    // Long after it went: a new load waits again.
    cleanup();
    await wait(400);
    render(
      <SkeletonGroup label="Carregando a lista">
        <Skeleton width={120} />
      </SkeletonGroup>,
    );
    expect(body().getByRole("status", { name: "Carregando a lista" }).hasAttribute("data-visible")).toBe(false);
  });

  test("a conversation looks like messages: avatars (people round, agents square), names, grouped follow-ups", () => {
    render(<SkeletonConversation label="Carregando mensagens" count={6} />);
    const group = body().getByRole("status", { name: "Carregando mensagens" });
    expect(group.querySelectorAll(".ac-skeleton-msg")).toHaveLength(6);
    expect(group.querySelectorAll(".ac-skeleton-msg--grouped").length).toBeGreaterThan(0);
    expect(group.querySelectorAll(".ac-skeleton--square").length).toBeGreaterThan(0);
    expect(group.querySelectorAll(".ac-skeleton--circle").length).toBeGreaterThan(0);
  });

  test("list rows", () => {
    render(<SkeletonList label="Carregando a lista" count={3} trailing />);
    expect(
      body().getByRole("status", { name: "Carregando a lista" }).querySelectorAll(".ac-skeleton-row"),
    ).toHaveLength(3);
  });
});

describe("Button loading", () => {
  test("spinner inside, label kept (same width), busy and not clickable", () => {
    let clicks = 0;
    render(
      <Button variant="primary" loading onClick={() => clicks++}>
        Salvar
      </Button>,
    );
    const button = body().getByRole("button", { name: "Salvar" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.className).toContain("ac-btn--loading");
    expect(button.querySelector(".ac-pixspin")).toBeTruthy();
    expect(button.textContent).toBe("Salvar");
    button.click();
    expect(clicks).toBe(0);
  });

  test("the label's text never shows under the spinner, disabled or not, whatever the variant", async () => {
    const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, i) => ({
      i,
      selectors: (m[1] ?? "").split(",").map((s) => s.replace(/\s+/g, " ").trim()),
      body: m[2] ?? "",
    }));
    const sets = (body: string, prop: string, value?: string) =>
      new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*${value ?? "[^;]+"}\\s*(?:;|$)`).test(body);
    const hides = rules.filter(
      (r) => sets(r.body, "color", "transparent") && sets(r.body, "-webkit-text-fill-color", "transparent"),
    );
    expect(hides.flatMap((r) => r.selectors)).toEqual(
      expect.arrayContaining([
        ".ac-btn.ac-btn--loading",
        ".ac-btn.ac-btn--loading:disabled",
        '.ac-btn.ac-btn--loading[aria-disabled="true"]',
      ]),
    );
    // After every rule that colors a disabled button, so that gray never wins at the same weight; the text fill
    // covers heavier ones (a ghost on a dark surface, the composer's send button).
    const disabledColors = rules.filter(
      (r) =>
        r.selectors.some((s) => /^\.ac-btn(?::disabled|\[aria-disabled="true"\])$/.test(s)) && sets(r.body, "color"),
    );
    expect(disabledColors.length).toBeGreaterThan(0);
    expect(Math.min(...hides.map((r) => r.i))).toBeGreaterThan(Math.max(...disabledColors.map((r) => r.i)));
    // The spinner (a canvas that reads `color`) keeps its own color.
    expect(
      rules.some(
        (r) =>
          r.selectors.includes(".ac-btn.ac-btn--loading .ac-btn__spinner") &&
          sets(r.body, "-webkit-text-fill-color", "currentColor"),
      ),
    ).toBe(true);
    expect(rules.some((r) => r.selectors.includes(".ac-btn--loading .ac-btn__spinner") && sets(r.body, "color"))).toBe(
      true,
    );
  });

  test("not loading: no spinner, no aria-busy", () => {
    render(<Button>Salvar</Button>);
    const button = body().getByRole("button", { name: "Salvar" });
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.querySelector(".ac-pixspin")).toBeNull();
  });
});

describe("SwapLabel", () => {
  test("words that take turns keep the button as wide as the wider one: the other stays, unseen and unread", async () => {
    const { rerender } = render(
      <Button>
        <SwapLabel label="Copiar link de convite" alt="Copiado" showAlt={false} />
      </Button>,
    );
    expect(body().getByRole("button", { name: "Copiar link de convite" })).toBeTruthy();
    rerender(
      <Button>
        <SwapLabel icon="copy" altIcon="check" label="Copiar link de convite" alt="Copiado" showAlt />
      </Button>,
    );
    const button = body().getByRole("button", { name: "Copiado" });
    expect(button.textContent).toBe("Copiar link de conviteCopiado");
    // Each word with its own icon: the one shown keeps its icon beside it, in the middle of the room the other keeps.
    expect(button.querySelectorAll(":scope > .ac-swap > * > .ac-icon")).toHaveLength(2);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-swap")).toContain("display: inline-grid");
    expect(rule(".ac-swap > *")).toContain("grid-area: 1 / 1");
    expect(rule(".ac-swap > *")).toContain("justify-self: center");
    expect(rule('.ac-swap > [aria-hidden="true"]')).toContain("visibility: hidden");
  });
});

describe("reduced motion", () => {
  test("every loading animation lives inside a no-preference block", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const start = css.indexOf("Loading: skeletons");
    expect(start).toBeGreaterThan(-1);
    const section = css.slice(start);
    // Strip the allowed blocks; no `animation:` may remain outside them. Under reduced motion only a 120ms fade.
    const calm = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g;
    for (const [block] of section.matchAll(calm))
      for (const a of block.matchAll(/\banimation:\s*([^;]+);/g))
        expect(a[1]?.trim()).toBe("ac-fade-in 120ms ease-out");
    const outside = section
      .replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "")
      .replace(calm, "");
    expect(outside).not.toMatch(/\banimation:/);
  });
});

describe("Refreshing", () => {
  test("a kept list dims and shows a running bar only past the delay, and is itself again when its rows land", async () => {
    const { rerender } = render(
      <Refreshing busy label="Carregando…">
        <ul>
          <li>Kept</li>
        </ul>
      </Refreshing>,
    );
    const box = document.querySelector(".ac-refreshing") as HTMLElement;
    expect(box.getAttribute("aria-busy")).toBe("true");
    // A quick switch never blinks: nothing shows yet.
    expect(box.hasAttribute("data-busy")).toBe(false);
    expect(body().queryByRole("progressbar")).toBeNull();
    await wait(SKELETON_DELAY_MS + 30);
    expect(box.hasAttribute("data-busy")).toBe(true);
    // The bar comes before the list, so the list's own box doesn't move.
    expect(box.firstElementChild).toBe(body().getByRole("progressbar", { name: "Carregando…" }));
    expect(body().getByText("Kept")).toBeTruthy();
    rerender(
      <Refreshing busy={false} label="Carregando…">
        <ul>
          <li>New</li>
        </ul>
      </Refreshing>,
    );
    expect(box.hasAttribute("aria-busy")).toBe(false);
    expect(box.hasAttribute("data-busy")).toBe(false);
    expect(body().queryByRole("progressbar")).toBeNull();
  });
});

describe("PageHeader metaActions", () => {
  test("the line under the title ends with the controls, the title's row keeps its own actions", () => {
    render(
      <PageHeader
        title="Caixa de entrada"
        meta="3 não lidas"
        actions={<Button aria-label="Marcar tudo como lido" />}
        metaActions={<Button>Tudo</Button>}
      />,
    );
    const head = document.querySelector(".ac-pagehead") as HTMLElement;
    expect([...head.children].map((c) => c.className)).toEqual(["ac-pagehead__row", "ac-pagehead__metaline"]);
    const line = head.querySelector(".ac-pagehead__metaline") as HTMLElement;
    expect(line.firstElementChild?.className).toBe("ac-pagehead__meta");
    expect(line.firstElementChild?.textContent).toBe("3 não lidas");
    expect(line.querySelector(".ac-pagehead__metaacts")?.textContent).toBe("Tudo");
    // Not twice: the line moved out of the title's block.
    expect(head.querySelectorAll(".ac-pagehead__meta")).toHaveLength(1);
  });
});
