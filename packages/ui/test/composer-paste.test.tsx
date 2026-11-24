import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer, ComposerFile, emojiQuery } from "../src/components/Composer";
import { pasteLink } from "../src/format";
import { pastedFiles, transferFiles } from "../src/transfer";

afterEach(() => cleanup());

const EMOJI = {
  button: "Emoji",
  dialog: "Emojis",
  search: "Buscar emoji",
  noResults: "Nenhum emoji",
  recent: "Recentes",
  results: "Resultados",
  categories: {
    smileys: "Carinhas",
    people: "Pessoas",
    nature: "Natureza",
    food: "Comida",
    activities: "Atividades",
    travel: "Viagem",
    objects: "Objetos",
    symbols: "Símbolos",
  },
};
const FORMAT = {
  toolbar: "Formatação",
  bold: "Negrito",
  italic: "Itálico",
  strike: "Tachado",
  code: "Código",
  codeBlock: "Bloco de código",
  link: "Link",
  bulletList: "Lista",
  numberedList: "Lista numerada",
  quote: "Citação",
};

const png = (name = "image.png") => new File(["x"], name, { type: "image/png" });
/** A clipboard or drop as the browser hands it: `files`, `items` and the text kinds. */
const transfer = (opts: { files?: File[]; items?: File[]; text?: Record<string, string>; types?: string[] }) => ({
  files: opts.files ?? [],
  items: (opts.items ?? []).map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  types: opts.types ?? (opts.files?.length || opts.items?.length ? ["Files"] : Object.keys(opts.text ?? {})),
  getData: (kind: string) => opts.text?.[kind] ?? "",
});

function Box({ files, initial = "" }: { files: File[][]; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={() => setValue("")}
      label="Mensagem"
      sendLabel="Enviar"
      onFiles={(f) => files.push(f)}
      format={FORMAT}
      emoji={EMOJI}
    />
  );
}

function setup(initial = "") {
  const files: File[][] = [];
  render(<Box files={files} initial={initial} />);
  const box = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
  const paste = async (data: ReturnType<typeof transfer>) => {
    const event = createEvent.paste(box, { clipboardData: data });
    await act(async () => {
      fireEvent(box, event);
    });
    return event;
  };
  return { box, files, paste };
}

test("a paste's files, or its file items when the engine fills only those (WebKit)", () => {
  const a = png("a.png");
  expect(transferFiles(transfer({ files: [a] }))).toEqual([a]);
  expect(transferFiles(transfer({ items: [a] }))).toEqual([a]);
  expect(transferFiles(transfer({ text: { "text/plain": "oi" } }))).toEqual([]);
  expect(transferFiles(null)).toEqual([]);
});

test("cells or words from an office app paste as text, never as the picture of themselves it puts beside them", () => {
  const cells = transfer({
    files: [png()],
    text: { "text/plain": "Q1\t120\nQ2\t140", "text/html": "<table><tr><td>Q1</td></tr></table>" },
  });
  expect(pastedFiles(cells)).toEqual([]);
  // A copied picture: no text, or HTML that holds the image.
  const shot = png();
  expect(pastedFiles(transfer({ files: [shot] }))).toEqual([shot]);
  expect(
    pastedFiles(transfer({ files: [shot], text: { "text/html": '<img src="https://example.com/a.png">' } })),
  ).toEqual([shot]);
});

test("a screenshot pasted in the box joins the message and nothing is typed", async () => {
  const { box, files, paste } = setup();
  const shot = png();
  const event = await paste(transfer({ items: [shot] }));
  expect(files).toEqual([[shot]]);
  expect(event.defaultPrevented).toBe(true);
  expect(box.value).toBe("");
});

test("a sheet's cells pasted in the box stay the browser's to type as text", async () => {
  const { files, paste } = setup();
  const event = await paste(
    transfer({ files: [png()], text: { "text/plain": "Q1\t120", "text/html": "<table><td>Q1</td></table>" } }),
  );
  expect(files).toEqual([]);
  expect(event.defaultPrevented).toBe(false);
});

test("a URL pasted over selected words links them, the caret after the link", async () => {
  const { box, paste } = setup("leia o guia hoje");
  await act(async () => {
    box.focus();
    box.setSelectionRange(7, 11);
  });
  await paste(transfer({ text: { "text/plain": "https://example.com/guia" } }));
  expect(box.value).toBe("leia o [guia](https://example.com/guia) hoje");
  expect(box.selectionStart).toBe("leia o [guia](https://example.com/guia)".length);
});

test("pasteLink only links a single URL over words on one line", () => {
  expect(pasteLink("a b", 0, 1, " https://example.com ")?.value).toBe("[a](https://example.com) b");
  expect(pasteLink("a b", 1, 1, "https://example.com")).toBeNull();
  expect(pasteLink("a b", 0, 1, "veja https://example.com")).toBeNull();
  expect(pasteLink("a\nb", 0, 3, "https://example.com")).toBeNull();
  expect(pasteLink("https://old.example.com", 0, 23, "https://example.com")).toBeNull();
});

test("a file dropped that the engine lists nowhere is still taken: the browser never opens it over the app", async () => {
  const { box, files } = setup();
  const card = box.closest(".ac-composer") as HTMLElement;
  const event = createEvent.drop(card, { dataTransfer: transfer({ types: ["Files"] }) });
  await act(async () => {
    fireEvent(card, event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(files).toEqual([]);
  const shot = png();
  await act(async () => {
    fireEvent.drop(card, { dataTransfer: transfer({ items: [shot] }) });
  });
  expect(files).toEqual([[shot]]);
});

test("':' and two letters list emoji by name: Enter puts the first in, with a space after it", async () => {
  const { box } = setup();
  await act(async () => {
    fireEvent.change(box, { target: { value: "ok :thumbs", selectionStart: 10, selectionEnd: 10 } });
  });
  const list = screen.getByRole("listbox", { name: "Emojis" });
  expect(list.textContent).toContain(":thumbs_up:");
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
  expect(box.value).toBe("ok 👍 ");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a time or a word before a colon never opens the emoji list", () => {
  expect(emojiQuery("às 10:30", 8)).toBeNull();
  expect(emojiQuery("Nota:ok", 7)).toBeNull();
  expect(emojiQuery(":s", 2)).toBeNull();
  expect(emojiQuery("oi :sm", 6)).toEqual({ start: 3, query: "sm" });
});

test("a file uploading shows the share sent as a bar along its foot, once it is known", () => {
  const { rerender } = render(
    <ComposerFile
      name="relatorio.pdf"
      status="uploading"
      statusLabel="enviando…"
      removeLabel="Remover"
      onRemove={() => {}}
    />,
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
  rerender(
    <ComposerFile
      name="relatorio.pdf"
      status="uploading"
      statusLabel="enviando…"
      progress={0.42}
      removeLabel="Remover"
      onRemove={() => {}}
    />,
  );
  expect(screen.getByRole("progressbar", { name: "enviando…" }).getAttribute("aria-valuenow")).toBe("42");
  rerender(<ComposerFile name="relatorio.pdf" status="done" progress={1} removeLabel="Remover" onRemove={() => {}} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
});
