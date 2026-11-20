import type { LiveRoom } from "@agenteschat/client";
import { LIVE_LIMITS, LOCAL } from "@agenteschat/live";
import { setNotes, slideNotes } from "@agenteschat/live/slides";
import { Icon } from "@agenteschat/ui";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";

/**
 * A slide's speaker notes (ADR 0196 §2), typed by several people at once: the field is bound to the slide's `Y.Text`.
 * What this person types changes only the characters that differ (`setNotes`), with their own undo; what others type
 * comes in where they typed it, and this person's caret keeps its place in the words around it.
 */
export function Notes({
  room,
  slideId,
  readOnly,
  open,
  onOpenChange,
}: {
  room: LiveRoom;
  slideId: string;
  readOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    const area = field.current;
    const text: Y.Text | null = slideNotes(room.doc, slideId);
    if (!area) return;
    area.value = text?.toString() ?? "";
    if (!text) return;
    const onChange = (event: Y.YTextEvent) => {
      const next = text.toString();
      if (area.value === next) return;
      // Someone else's words (or an undo): keep the caret where it was among the words around it.
      let start = area.selectionStart;
      let end = area.selectionEnd;
      let at = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) at += op.retain;
        else if (typeof op.insert === "string") {
          const n = op.insert.length;
          if (at < start) start += n;
          if (at < end) end += n;
          at += n;
        } else if (op.delete !== undefined) {
          const n = op.delete;
          if (at < start) start -= Math.min(n, start - at);
          if (at < end) end -= Math.min(n, end - at);
        }
      }
      const focused = document.activeElement === area;
      area.value = next;
      if (focused) area.setSelectionRange(start, end);
    };
    text.observe(onChange);
    return () => text.unobserve(onChange);
  }, [room, slideId]);

  // The desktop app's Edit menu sends undo and redo as input events (React's onBeforeInput isn't the native one).
  useEffect(() => {
    const area = field.current;
    if (!area) return;
    const onBefore = (e: InputEvent) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      e.preventDefault();
      if (e.inputType === "historyUndo") room.undo.undo();
      else room.undo.redo();
    };
    area.addEventListener("beforeinput", onBefore);
    return () => area.removeEventListener("beforeinput", onBefore);
  }, [room]);

  const write = () => {
    const area = field.current;
    if (!area || readOnly) return;
    try {
      setNotes(room.doc, slideId, area.value.slice(0, LIVE_LIMITS.slides.textChars), LOCAL);
    } catch {
      // The slide was deleted meanwhile: nothing to write to.
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    // The file's undo, not the field's own: it holds what this person did everywhere.
    if (key === "z" || key === "y") {
      e.preventDefault();
      e.stopPropagation();
      if (key === "y" || e.shiftKey) room.undo.redo();
      else room.undo.undo();
    }
  };

  return (
    <section className="sl-notes" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="sl-notes__head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name={open ? "chevronDown" : "chevronUp"} size={16} />
        {t("live.slides.notes.title")}
      </button>
      <textarea
        id={id}
        ref={field}
        hidden={!open}
        className="sl-notes__field"
        aria-label={t("live.slides.notes.title")}
        placeholder={readOnly ? "" : t("live.slides.notes.placeholder")}
        readOnly={readOnly}
        maxLength={LIVE_LIMITS.slides.textChars}
        onInput={write}
        onKeyDown={onKeyDown}
        spellCheck
      />
    </section>
  );
}
