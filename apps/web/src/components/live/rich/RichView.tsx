import { isRichColor, isRichHref, type RichDoc, type RichRun } from "@agenteschat/live/rich";
import { cx } from "@agenteschat/ui";
import type { CSSProperties, ReactNode } from "react";
import { listNumbers, paragraphDomAttrs } from "./schema";
import "./rich.css";

/**
 * Rich text drawn as it is, with nothing to edit (ADR 0196 §2): slide thumbnails, presenting, read-only files, the
 * canvas at rest. It writes the same elements and classes the editor's schema does (rich.css styles both), so a text
 * box doesn't move by a pixel when it starts or stops being edited.
 */
export function RichView({
  doc,
  placeholder,
  className,
  style,
}: {
  doc: RichDoc;
  /** Shown in the box's quiet color while it holds no text (editing screens only, never presenting). */
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const empty = !doc.some((p) => p.runs.some((r) => r.text));
  if (empty) {
    const first = doc[0];
    return (
      <div className={cx("rt", className)} style={style}>
        <p
          {...domProps(paragraphDomAttrs(first ?? {}))}
          className={cx("rt-p", placeholder && "rt-empty")}
          data-placeholder={placeholder || undefined}
        >
          <br />
        </p>
      </div>
    );
  }
  const numbers = listNumbers(doc);
  return (
    <div className={cx("rt", className)} style={style}>
      {doc.map((p, i) => {
        const attrs = paragraphDomAttrs({ ...p, ...(numbers[i] !== null ? { n: numbers[i] ?? 1 } : {}) });
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one text, in order
          <p key={i} {...domProps(attrs)}>
            {p.runs.length ? (
              p.runs.map((run, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the runs of one paragraph, in order
                <Run key={j} run={run} />
              ))
            ) : (
              <br />
            )}
          </p>
        );
      })}
    </div>
  );
}

/** The attributes `paragraphDomAttrs` gives the editor's DOM, as React props. */
function domProps(attrs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") out.className = value;
    else if (key === "style") {
      const align = /text-align:\s*(\w+)/.exec(value)?.[1];
      if (align) out.style = { textAlign: align };
    } else out[key] = value;
  }
  return out;
}

function Run({ run }: { run: RichRun }) {
  const parts = run.text.split("\n");
  let node: ReactNode = parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one run
    <span key={i}>
      {i > 0 && <br />}
      {part}
    </span>
  ));
  if (parts.length === 1) node = run.text;
  // The editor's order, innermost last: bold, italic, underline, strike, color, link.
  if (run.link && isRichHref(run.link)) {
    node = (
      <a href={run.link} rel="noopener noreferrer nofollow" target="_blank">
        {node}
      </a>
    );
  }
  if (run.color && isRichColor(run.color)) node = <span style={{ color: run.color }}>{node}</span>;
  if (run.strike) node = <s>{node}</s>;
  if (run.underline) node = <u>{node}</u>;
  if (run.italic) node = <em>{node}</em>;
  if (run.bold) node = <strong>{node}</strong>;
  return <>{node}</>;
}
