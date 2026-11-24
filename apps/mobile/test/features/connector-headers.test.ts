import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { heldWhole } from "@agenteschat/client/lib/format";
import {
  BLANK_HEADER,
  connectsWithoutKey,
  headerRefused,
  headersToSend,
  MAX_REQUEST_HEADERS,
  savedHeadersLine,
  savedHeadersUnreadable,
} from "@agenteschat/client/lib/request-headers";
import { headerNamesText, needsKeyText } from "../../src/features/connectors/logic";
import { translator } from "./fixtures";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src/features/connectors", file), "utf8");
const refusal = (code: string, params?: Record<string, unknown>) => new ApiError(400, code, "refused", params);

/** A header's name as the lines show it: whole, never broken at a hyphen. */
const key = heldWhole("X-API-Key");
const tenant = heldWhole("X-Tenant");

describe("request headers of a server by address", () => {
  test("the lines that name them say the names as a list, in each language", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(headerNamesText(pt, "connectors.sendsToo", ["X-API-Key"])).toBe(
      `Envia também: ${key}. Para mudar, use Reconectar.`,
    );
    expect(headerNamesText(en, "connectors.sendsToo", ["X-API-Key", "X-Tenant"])).toBe(
      `Also sends: ${key} and ${tenant}. To change that, use Reconnect.`,
    );
    // Reconectar: one saved name and several read right, kept or about to go.
    expect(headerNamesText(pt, "connectFlow.headers.saved", ["X-API-Key"])).toBe(
      `Salvo: ${key}. Continua, a menos que você digite novos.`,
    );
    expect(headerNamesText(pt, "connectFlow.headers.saved", ["X-API-Key", "X-Tenant"])).toBe(
      `Salvos: ${key} e ${tenant}. Continuam, a menos que você digite novos.`,
    );
    expect(headerNamesText(pt, "connectFlow.headers.dropping", ["X-API-Key"])).toBe(`${key} sai ao reconectar.`);
    expect(headerNamesText(pt, "connectFlow.headers.dropping", ["X-API-Key", "X-Tenant"])).toBe(
      `${key} e ${tenant} saem ao reconectar.`,
    );
    expect(headerNamesText(en, "connectFlow.headers.saved", ["X-API-Key"])).toBe(
      `Saved: ${key}. It stays unless you type new ones.`,
    );
    expect(headerNamesText(en, "connectFlow.headers.dropping", ["X-API-Key", "X-Tenant"])).toBe(
      `${key} and ${tenant} will be removed when you reconnect.`,
    );
    // `$` and `'` may be in a name: they are said as typed.
    expect(headerNamesText(pt, "connectors.sendsToo", ["X-$'-Key", "X-$&"])).toBe(
      `Envia também: ${heldWhole("X-$'-Key")} e ${heldWhole("X-$&")}. Para mudar, use Reconectar.`,
    );
  });

  test("the most a server takes, each name as long as a name gets: every one is said, and no slot is left", async () => {
    const names = Array.from({ length: MAX_REQUEST_HEADERS }, (_, i) => `X-${String(i).padEnd(62, "a")}`);
    for (const lng of ["pt-BR", "en"] as const) {
      const line = headerNamesText(await translator(lng), "connectors.sendsToo", names);
      expect(line).not.toContain("<names/>");
      for (const name of names) expect(line).toContain(heldWhole(name));
    }
  });

  test("headers sent alone and refused: the sheet says so, never 'this server asks for a key'", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(needsKeyText(pt, { status: "needs_key" }, "Acme", true)).toBe(
      "O servidor não aceitou esses cabeçalhos. Confira os valores, ou conecte com uma chave de API.",
    );
    expect(needsKeyText(en, { status: "needs_key" }, "Acme", true)).toBe(
      "The server didn't accept these headers. Check their values, or connect with an API key.",
    );
    expect(needsKeyText(pt, { status: "needs_key" }, "Acme")).toBe("Esse servidor pede uma chave.");
    // A server that only lets approved apps sign in says that, with or without headers.
    expect(needsKeyText(en, { status: "needs_key", reason: "not_approved" }, "Acme", true)).toBe(
      needsKeyText(en, { status: "needs_key", reason: "not_approved" }, "Acme"),
    );
  });

  test("a refused row reads in plain words with the way out, naming the header", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(errorText(pt, refusal("connector.header_twice", { header: "X-API-Key", index: 1 }), "pt-BR")).toBe(
      "X-API-Key está na lista duas vezes. Remova um deles.",
    );
    expect(errorText(en, refusal("connector.header_reserved", { header: "Host", index: 0 }), "en")).toBe(
      "Host is already sent with every request and can't be changed. Remove this header.",
    );
    expect(errorText(pt, refusal("connector.headers_too_many", { max: MAX_REQUEST_HEADERS }), "pt-BR")).toBe(
      "Um servidor aceita no máximo 10 cabeçalhos. Remova um para adicionar outro.",
    );
    expect(errorText(pt, refusal("connector.headers_with_sign_in"), "pt-BR")).toBe(
      "Este servidor pede login, e o login ainda não leva cabeçalhos. Remova os cabeçalhos para entrar, ou conecte com uma chave de API.",
    );
  });
});

describe("the sheet that connects a server by address", () => {
  const sheet = src("ConnectSheet.tsx");
  const form = src("RequestHeaders.tsx");
  /** A row that says something. */
  const typed = [{ name: "X-Trace", value: "" }];

  test("the headers sit under the key, over Conectar, and turn off with the rest while it connects", () => {
    const keyField = sheet.indexOf("accessibilityLabel={keyLabel}");
    const headers = sheet.indexOf("<RequestHeaders");
    expect(keyField).toBeGreaterThan(0);
    expect(keyField).toBeLessThan(headers);
    expect(headers).toBeLessThan(sheet.indexOf("onPress={() => void submitKey()}"));
    expect(sheet).toMatch(/\{canHeaders \? \(\s*<Locked when=\{busy\}>\s*<RequestHeaders/);
  });

  test("only a server the catalog doesn't list gets them, or an account that already has some", () => {
    expect(sheet).toContain(
      "const canHeaders = byAddress && !viaComposio && (def === null || savedHeaders.length > 0);",
    );
    expect(sheet).toContain("const savedHeaders = (reconnect && item?.server?.headerNames) || [];");
  });

  test("they go with a key and without one, and alone they connect", () => {
    expect(sheet.split("...(headers ? { headers } : {}),").length - 1).toBe(2);
    expect(sheet).toContain(
      'if (canHeaders && connectsWithoutKey(headers, savedHeaders) && key.trim() === "") return signIn();',
    );
    expect(sheet).toContain("needsKeyText(t, res, shownName, sendsHeaders, ownWay)");
  });

  test("removing the headers of an account that has no key asks for no key: Remover then Conectar says none any more", () => {
    // Remover with no row typed: the request's list is empty, and it goes the way of headers alone.
    const removed = headersToSend([], true);
    expect(removed).toEqual([]);
    expect(connectsWithoutKey(removed, ["X-API-Key"])).toBe(true);
    // An empty list is still said in the request: `[]` removes them, saying nothing would keep them.
    expect({ ...(removed ? { headers: removed } : {}) }).toEqual({ headers: [] });
    // Before the key is looked at: it is short only when one is asked for.
    const submit = sheet.slice(sheet.indexOf("const submitKey = "), sheet.indexOf("const installApp = "));
    expect(submit.indexOf("connectsWithoutKey(headers, savedHeaders)")).toBeGreaterThan(0);
    expect(submit.indexOf("connectsWithoutKey(headers, savedHeaders)")).toBeLessThan(
      submit.indexOf('t("mobile.connectors.keyShort")'),
    );
    // A server with nothing saved and nothing typed still asks for its key.
    expect(connectsWithoutKey(headersToSend([BLANK_HEADER], false), [])).toBe(false);
  });

  test("a header's refusal opens the headers, whichever way in was tried", () => {
    const failed = sheet.slice(sheet.indexOf("const failed = "), sheet.indexOf("/** The browser round trip"));
    expect(failed).toContain("headerRefused(headerRows, headers, error)");
    expect(failed).toContain('setMode("key");');
    expect(failed).toContain("setHeadersOpen(true);");
    // Saved ones that can't be read: remembered, never removed for the person. A second Conectar is refused again.
    // Only where the saved names are on screen: without them the refusal shows under the rows, never nowhere.
    expect(failed).toContain("if (savedHeadersUnreadable(error) && savedHeaders.length > 0) setUnreadable(refusal);");
    expect(failed).toContain("else setRefused(refusal);");
    expect(failed).not.toContain("setDropSaved");
    // Until the sheet closes: nothing else sets it, so no change forgets it.
    expect(sheet.split("setUnreadable(").length - 1).toBe(1);
    // Removing is the person's choice alone: only the form's own change sets it.
    expect(sheet.split("setDropSaved(").length - 1).toBe(1);
    expect(sheet).toContain("unreadable={unreadable}");
  });

  test("saved headers that can't be read any more: the refusal takes their line, over Remover, in the person's language", async () => {
    const unreadable = refusal("connector.headers_unreadable");
    expect(errorText(await translator("pt-BR"), unreadable, "pt-BR")).toBe(
      "Não deu para ler os cabeçalhos salvos. Digite de novo, ou remova.",
    );
    expect(errorText(await translator("en"), unreadable, "en")).toBe(
      "The saved headers couldn't be read. Type them again, or remove them.",
    );
    // Reconectar sent no list: the refusal is about the saved ones, on no row.
    expect(headerRefused([], undefined, unreadable)).toEqual({ row: null, field: "name", error: unreadable });
    expect([savedHeadersUnreadable(unreadable), savedHeadersUnreadable(refusal("connector.header_twice"))]).toEqual([
      true,
      false,
    ]);
    // Its words stand where the saved names were said to stay, with Remover right under them, inside what the sheet
    // opens on a refusal. The sentence about the names is the other branch: the two never show together.
    const open = form.slice(form.indexOf("{open ? ("));
    expect(open).toMatch(
      /\{line\.says === "unreadable" && unreadable \? \(\s*why\(unreadable\)\s*\) : \(\s*<Text variant="small" tone="ink">\s*\{headerNamesText\(/,
    );
    expect(open.indexOf("why(unreadable)")).toBeLessThan(open.indexOf("{line.action ? ("));
    expect(form).toContain("const line = savedHeadersLine(rows, dropSaved, unreadable !== null);");
    expect(form).toContain("{errorText(t, refusal.error, i18n.language)}");
    // Neither Remover chosen nor a row typed: the refusal with Remover, whatever else changed. Never "Continuam".
    expect(savedHeadersLine([], false, true)).toEqual({ says: "unreadable", action: "drop" });
    expect(savedHeadersLine([BLANK_HEADER], false, true)).toEqual({ says: "unreadable", action: "drop" });
    // Remover chosen: they go, with Desfazer, which leads back to the refusal. A row typed: they go, with no button.
    expect(savedHeadersLine([], true, true)).toEqual({ says: "dropping", action: "undo" });
    expect(savedHeadersLine(typed, false, true)).toEqual({ says: "dropping", action: null });
    // A plain second Conectar says nothing about headers, so it removes none. Remover then Conectar says `[]`.
    expect(headersToSend([], false)).toBeUndefined();
    expect(headersToSend([], true)).toEqual([]);
  });

  test("a refusal about a saved header that was read leaves its line as it is, under the rows", () => {
    const kept = refusal("connector.header_and_key", { header: "Authorization", index: 0 });
    expect(savedHeadersUnreadable(kept)).toBe(false);
    expect(headerRefused([], undefined, kept)).toEqual({ row: null, field: "name", error: kept });
    expect(savedHeadersLine([], false, false)).toEqual({ says: "saved", action: "drop" });
    // Under the rows, over the button that adds one.
    const open = form.slice(form.indexOf("{open ? ("));
    const line = open.indexOf("{refused && refused.row === null ? why(refused) : null}");
    expect(line).toBeGreaterThan(open.indexOf('"connectFlow.headers.drop"'));
    expect(line).toBeLessThan(open.indexOf('t("connectFlow.headers.add")'));
  });

  test("closed until asked for, a value typed as a secret, and at the most rows no more are added, with why", () => {
    expect(form).toContain("accessibilityState={{ expanded: open }}");
    expect(sheet).toContain("useState(savedHeaders.length > 0);");
    const value = form.slice(form.indexOf("value={row.value}"), form.indexOf("<IconButton"));
    expect(value).toContain("secureTextEntry");
    expect(value).toContain('autoComplete="off"');
    // A name longer than the server takes can't be typed: its refusal would name no way out.
    expect(form.slice(form.indexOf("value={row.name}"), form.indexOf("value={row.value}"))).toContain(
      "maxLength={MAX_HEADER_NAME}",
    );
    expect(form).toContain("const full = rows.length >= MAX_REQUEST_HEADERS;");
    expect(form).toContain("disabled={full}");
    expect(form).toMatch(/\{full \? \(\s*<Text variant="footnote" tone="muted">\s*\{tooMany\}/);
  });

  test("the help reads under the title without a tap, and the saved names offer removing them", () => {
    const help = form.indexOf('t("connectFlow.headers.help")');
    expect(form.indexOf('t("connectFlow.headers.title")')).toBeLessThan(help);
    expect(form.slice(0, help)).not.toContain("InfoHint");
    expect(form).toContain('t(line.action === "drop" ? "connectFlow.headers.drop" : "connectFlow.headers.undo")');
    expect(form).toContain('onPress={() => onChange(rows, line.action === "drop")}');
  });

  test("a typed row replaces the saved names: their line says they go, with no button that would keep them", () => {
    expect(savedHeadersLine(typed, false, false)).toEqual({ says: "dropping", action: null });
    expect(savedHeadersLine([BLANK_HEADER], false, false)).toEqual({ says: "saved", action: "drop" });
    expect(form).toContain('line.says === "saved" ? "connectFlow.headers.saved" : "connectFlow.headers.dropping"');
    expect(form).toMatch(/\{line\.action \? \(\s*<Button\s+variant="text"/);
  });
});

describe("a connection's screen", () => {
  test("names what a server by address is also sent, right under Reconectar, and nothing when it sends none", () => {
    const screen = src("ConnectionScreen.tsx");
    expect(screen).toContain("const sent = item?.server?.headerNames ?? [];");
    expect(screen).toMatch(
      /\{sent\.length > 0 \? \(\s*<GroupedFooter>\{headerNamesText\(t, "connectors\.sendsToo", sent\)\}<\/GroupedFooter>\s*\) : null\}/,
    );
    expect(screen.indexOf('"connectors.detail.reconnect"')).toBeLessThan(screen.indexOf('"connectors.sendsToo"'));
  });
});
