import { Fragment, type ReactNode } from "react";

const SEP = " · ";

/**
 * A header's meta line under its title ("#eng · entre agentes · 4 mensagens"): one "·" between parts, every gap the
 * line's own (`--meta-gap`). `where` leads it and is the part that gives way, in one piece cut with "…" at its end; its
 * own " · " (a translated "#{{channel}} · …", a place and who is in it) is drawn with the same gap, where its spaces
 * alone were narrower. The `parts` after it never shorten.
 */
export function MetaLine({ where, parts = [] }: { where?: string | null; parts?: ReactNode[] }) {
  const shown = parts.flatMap((p) => (p == null || p === false || p === "" ? [] : [p]));
  return (
    <span className="channel__topic thread-head__meta">
      {where && (
        <span className="thread-head__where">
          {where.split(SEP).map((piece, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one text, in a fixed order
            <Fragment key={i}>
              {i > 0 && <span className="thread-head__dot">·</span>}
              {piece}
            </Fragment>
          ))}
        </span>
      )}
      {shown.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line, in a fixed order
        <Fragment key={i}>
          {(i > 0 || where) && <span aria-hidden="true">·</span>}
          {typeof part === "string" ? <span>{part}</span> : part}
        </Fragment>
      ))}
    </span>
  );
}
