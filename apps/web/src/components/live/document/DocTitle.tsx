import { useRenameLiveFile } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { forgetJustCreated, wasJustCreated } from "../just-created";

/**
 * A document's title on its page (ADR 0200), the Wiki's (`wiki-title`): the file's own name, renamed where it is. It
 * reads as the page's title and turns into its field on a click or Tab, wrapping as the title does; Enter renames and
 * goes on to the text, leaving it renames, Esc puts it back. A new document opens with it selected, ready to be named.
 */
export function DocTitle({
  orgId,
  fileId,
  value,
  canRename,
  onEnter,
}: {
  orgId: string;
  fileId: string;
  value: string;
  canRename: boolean;
  /** Enter: on to the text. */
  onEnter: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const rename = useRenameLiveFile(orgId, fileId);
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // Renamed elsewhere (another person, an agent) while not editing: the new name.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  // A document just made from "New": its title selected, ready to be named (once; kept a moment for a remount).
  useEffect(() => {
    if (!canRename || !wasJustCreated(fileId)) return;
    field.current?.focus();
    field.current?.select();
    const id = setTimeout(() => forgetJustCreated(fileId), 1000);
    return () => clearTimeout(id);
  }, [canRename, fileId]);
  if (!canRename) return <h1 className="wiki-title lf-doc__title lf-doc__title--still">{value}</h1>;
  const commit = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    setEditing(false);
    if (next && next !== value) {
      rename.mutate(next, { onError: (error) => toast.show(errorText(t, error, i18n.language), "error") });
    } else setDraft(value);
  };
  return (
    <h1 className="wiki-title lf-doc__title">
      <span className="lf-doc__title-mirror" aria-hidden="true">
        {`${draft || " "} `}
      </span>
      <textarea
        ref={field}
        className="lf-doc__title-field"
        aria-label={t("live.doc.title")}
        placeholder={t("live.kinds.untitled.document")}
        value={draft}
        rows={1}
        maxLength={200}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
            onEnter();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft(value);
            setEditing(false);
            // Blurring now would rename with the old draft: put it back first, then leave.
            requestAnimationFrame(() => field.current?.blur());
          }
        }}
      />
    </h1>
  );
}
