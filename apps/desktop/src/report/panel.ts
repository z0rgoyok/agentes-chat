/**
 * The app's "Send a report" panel, plain DOM so the cover (no React there) and Preferences share it: the lead, notes
 * for what's missing, the note and reply address, everything that's sent behind a disclosure, then Cancel, Copy report
 * and Send. Sent, it shows the report's code.
 */
import { redactCommon } from "@agenteschat/adapters/redact";
import { replyAddressOk } from "@agenteschat/client/lib/problem-report";
import { invoke } from "@tauri-apps/api/core";
import type { DesktopTranslations } from "../i18n/keys.en";
import { fillIn } from "../ui/time";
import { type DesktopReport, reportText, type SendAnswer } from "./report";
import "./report.css";

const NOTE_MAX = 2000;

export interface PanelOptions {
  words: DesktopTranslations["report"];
  lead: string;
  /** The report, or why it couldn't be made (shown, with Copy and Send off). */
  report: DesktopReport | null;
  notes?: string[];
  onClose: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Builds the panel into `host` (emptied first). Returns a function that removes it. */
export function mountReportPanel(host: HTMLElement, { words, lead, report, notes = [], onClose }: PanelOptions) {
  const panel = el("div", "dk-report");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", words.title);
  host.replaceChildren(panel);
  let on = true;
  void invoke<boolean>("problem_report_on").then(
    (yes) => {
      on = yes;
      draw();
    },
    () => undefined,
  );
  let note = "";
  let replyTo = "";
  let busy = false;
  let error = "";

  const copy = (text: string, button: HTMLButtonElement, label: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      button.textContent = words.copied;
      setTimeout(() => {
        button.textContent = label;
      }, 2000);
    });

  function sentView(id: string) {
    panel.replaceChildren(
      el("h2", "dk-report__title", fillIn(words.sentTitle, { id })),
      el(
        "p",
        "dk-report__lead",
        replyTo.trim() ? fillIn(words.sentTextReply, { email: replyTo.trim() }) : words.sentText,
      ),
    );
    const acts = el("div", "dk-report__acts");
    const code = el("button", "", words.copyCode);
    code.type = "button";
    code.addEventListener("click", () => copy(id, code, words.copyCode));
    const done = el("button", "is-primary", words.done);
    done.type = "button";
    done.addEventListener("click", onClose);
    acts.append(code, done);
    panel.append(acts);
    done.focus();
  }

  function draw() {
    const title = el("h2", "dk-report__title", words.title);
    const leadLine = el("p", "dk-report__lead", lead);
    const list = el("ul", "dk-report__notes");
    for (const n of [...notes, ...(on ? [] : [words.offApp])]) list.append(el("li", "", n));

    const noteLabel = el("label", "dk-report__label", words.noteLabel);
    const noteBox = el("textarea", "dk-report__input");
    noteBox.id = "dk-report-note";
    noteLabel.htmlFor = noteBox.id;
    noteBox.rows = 3;
    noteBox.placeholder = words.notePlaceholder;
    noteBox.value = note;
    noteBox.disabled = busy;

    const emailLabel = el("label", "dk-report__label", words.emailLabel);
    const emailBox = el("input", "dk-report__input");
    emailBox.id = "dk-report-email";
    emailLabel.htmlFor = emailBox.id;
    emailBox.type = "email";
    emailBox.autocomplete = "off";
    emailBox.value = replyTo;
    emailBox.disabled = busy;
    const emailHelp = el("p", "dk-report__help");

    const all = el("details", "dk-report__all");
    const summary = el("summary", "", words.showAll);
    const text = el("pre", "dk-report__text");
    all.append(summary, text);

    const errorLine = el("p", "dk-report__error", error);
    errorLine.setAttribute("role", "alert");

    const acts = el("div", "dk-report__acts");
    const cancel = el("button", "", words.cancel);
    cancel.type = "button";
    cancel.disabled = busy;
    cancel.addEventListener("click", onClose);
    const copyButton = el("button", on ? "" : "is-primary", words.copy);
    copyButton.type = "button";
    copyButton.disabled = busy || !report;
    copyButton.addEventListener(
      "click",
      () => report && copy(reportText(report, note, replyTo), copyButton, words.copy),
    );
    const send = el("button", "is-primary", busy ? words.sending : words.send);
    send.type = "button";

    const sync = () => {
      const bad = !replyAddressOk(replyTo);
      emailHelp.textContent = bad ? words.emailInvalid : words.emailHelp;
      emailHelp.classList.toggle("is-bad", bad);
      emailBox.setAttribute("aria-invalid", String(bad));
      send.disabled = busy || !report || bad || note.trim().length > NOTE_MAX;
      if (report) text.textContent = reportText(report, note, replyTo);
    };
    noteBox.addEventListener("input", () => {
      note = noteBox.value;
      sync();
    });
    emailBox.addEventListener("input", () => {
      replyTo = emailBox.value;
      sync();
    });
    send.addEventListener("click", () => {
      if (!report || send.disabled) return;
      busy = true;
      error = "";
      draw();
      const sent = {
        ...report,
        note: note.trim() ? redactCommon(note.trim()).slice(0, NOTE_MAX) : null,
        replyTo: replyTo.trim() || null,
      };
      void invoke<SendAnswer>("problem_report_send", { json: JSON.stringify(sent) })
        .catch((): SendAnswer => ({ error: "unreachable" }))
        .then((answer) => {
          busy = false;
          if (answer.id) return sentView(answer.id);
          error =
            answer.error === "rate_limited"
              ? fillIn(words.errorRate, { minutes: String(Math.max(1, Math.ceil((answer.retryAfterS ?? 60) / 60))) })
              : answer.error === "unreachable"
                ? words.errorUnreachable
                : words.errorRefused;
          draw();
        });
    });
    acts.append(cancel, copyButton, ...(on ? [send] : []));
    panel.replaceChildren(
      title,
      leadLine,
      ...(list.childElementCount ? [list] : []),
      noteLabel,
      noteBox,
      emailLabel,
      emailBox,
      emailHelp,
      ...(report ? [all] : []),
      ...(error ? [errorLine] : []),
      acts,
    );
    sync();
  }

  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy) onClose();
  };
  document.addEventListener("keydown", esc);
  draw();
  return () => {
    document.removeEventListener("keydown", esc);
    host.replaceChildren();
  };
}
