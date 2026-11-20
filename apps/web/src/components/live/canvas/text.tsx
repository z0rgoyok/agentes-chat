import type { PeerUser } from "@agenteschat/live/awareness";
import { type ShapeView, shapeTextFragment } from "@agenteschat/live/canvas";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePeerLooks } from "../peers";
import { RichText, RichView } from "../rich";
import { useCanvasEnv } from "./context";

/**
 * The words of a note, a text or a shape's label (ADR 0196 §2): drawn from the shape's rich text, and while someone
 * types in it, the shared editor bound to the shape's own text in the document (others see each letter and each
 * other's carets, in their colors). Esc or a press elsewhere ends typing; a text box then takes the height its words
 * need. ⌘Z inside it takes back this person's own typing, through the file's undo.
 */
export function CanvasRich({
  shape,
  editing,
  className,
  style,
}: {
  shape: ShapeView;
  editing: boolean;
  className: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const env = useCanvasEnv();
  const looks = usePeerLooks();
  const box = useRef<HTMLDivElement>(null);
  const fragment = editing && !env.readOnly ? shapeTextFragment(env.room.doc, shape.id) : null;
  const id = shape.id;
  const done = useRef(env.doneEditing);
  done.current = env.doneEditing;

  // The box closing for any reason (Esc, a press elsewhere, the shape gone) says how tall its words came out.
  useEffect(() => {
    if (!editing) return;
    const el = box.current;
    return () => {
      done.current(id, el ? { h: el.scrollHeight } : undefined);
    };
  }, [editing, id]);

  const caretLook = useCallback(
    (_clientId: number, user: PeerUser) => {
      const look = looks(user);
      return { name: look.name, color: look.color };
    },
    [looks],
  );

  const kind = shape.type === "note" ? "note" : shape.type === "text" ? "text" : "label";
  const placeholder = t(`live.canvas.placeholders.${kind}`);
  const empty = !shape.text?.some((p) => p.runs.some((r) => r.text.trim()));
  return (
    <div ref={box} className={className} style={style} data-empty={empty || undefined}>
      {fragment ? (
        <RichText
          fragment={fragment}
          label={t(`live.canvas.textBox.${kind}`)}
          awareness={env.room.awareness}
          look={caretLook}
          undoManager={env.room.undo}
          placeholder={placeholder}
          focusAt={env.caretFor(id)}
          onEscape={() => env.stopEditing(id)}
        />
      ) : (
        <RichView doc={shape.text ?? []} />
      )}
    </div>
  );
}
