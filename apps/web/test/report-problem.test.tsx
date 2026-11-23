import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ProblemReportPreview } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ReportProblem } from "@/components/ReportProblem";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const button = (name: string | RegExp) => screen().getByRole("button", { name });

test("nothing on agentes.chat itself", async () => {
  await renderPage(<ReportProblem place="settings" />, { api: createFakeApi(seedState()), org: true });
  expect(screen().queryByRole("button", { name: "Enviar um relatório" })).toBeNull();
});

test("loading disables Send and Copy, the sent state shows the code", async () => {
  let release: (p: ProblemReportPreview) => void = () => {};
  const api = createFakeApi(
    seedState({
      edition: "selfhost",
      problemReport: () => new Promise<ProblemReportPreview>((r) => (release = r)),
    }),
  );
  await renderPage(<ReportProblem place="settings" />, { api, org: true });
  await click(button("Enviar um relatório"));
  expect(button("Enviar").hasAttribute("disabled")).toBe(true);
  expect(button("Copiar relatório").hasAttribute("disabled")).toBe(true);
  await act(async () =>
    release({ report: { format: 1, source: "server", place: "settings" }, text: "{}", send: "on", missing: {} }),
  );
  await settle();
  expect(button("Enviar").hasAttribute("disabled")).toBe(false);
  await click(button("Enviar"));
  await waitFor(() => expect(screen().getByText("Relatório R-7K3QXM enviado")).toBeTruthy());
});

test("a failed send keeps the note and says the way out", async () => {
  const api = createFakeApi(
    seedState({
      edition: "selfhost",
      problemReportSend: new ApiError(429, "rate_limited", "Too many", { retryAfterS: 120 }),
    }),
  );
  await renderPage(<ReportProblem place="settings" />, { api, org: true });
  await click(button("Enviar um relatório"));
  await settle();
  const note = screen().getByLabelText("O que aconteceu? (opcional)") as HTMLTextAreaElement;
  await act(async () => fireEvent.change(note, { target: { value: "It froze" } }));
  await click(button("Enviar"));
  await waitFor(() => expect(screen().getByRole("alert").textContent).toContain("2 min"));
  expect(note.value).toBe("It froze");
});
