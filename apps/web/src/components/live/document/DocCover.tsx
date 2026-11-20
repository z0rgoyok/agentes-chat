import { useApi } from "@agenteschat/client";
import {
  type DocBlock,
  type DocParagraph,
  type DocRun,
  type DocumentPreview,
  markdownToBlocks,
} from "@agenteschat/live/document";
import { cx } from "@agenteschat/ui";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { useOrg } from "@/components/org-context";
import "./doc-cover.css";

/**
 * A document drawn small (ADR 0200, ADR 0196 §7): its first blocks on a page of the Wiki's look, in the Drive's cards
 * and rows and the cards in messages. Words only as plain text (marks are too small to read here), headings bold,
 * list items with their marks, a table's first rows on a grid, pictures as they are. No editor in it: the Drive and
 * the chat load it alone.
 */

/** Blocks a cover draws at most (the preview keeps about a first page). */
const COVER_BLOCKS = 12;

const runsText = (runs: readonly DocRun[]) =>
  runs
    .map((r) => r.text)
    .join("")
    .replace(/\n/g, " ");

function Line({ p }: { p: DocParagraph }) {
  const level = Math.min(4, p.level ?? 0);
  return (
    <span
      className="lf-doc-mini__p"
      data-list={p.list}
      style={level ? ({ "--lv": String(level) } as CSSProperties) : undefined}
    >
      {runsText(p.runs)}
    </span>
  );
}

function Block({ block, image }: { block: DocBlock; image: (asset: string) => string | null }): ReactNode {
  switch (block.type) {
    case "paragraph":
      return block.runs.length ? <Line p={block} /> : null;
    case "heading":
      return (
        <span className="lf-doc-mini__h" data-level={block.level}>
          {runsText(block.runs)}
        </span>
      );
    case "blockquote":
      return (
        <span className="lf-doc-mini__quote">
          {block.blocks.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed picture of the first blocks.
            <Block key={i} block={b} image={image} />
          ))}
        </span>
      );
    case "code_block":
      return <span className="lf-doc-mini__code">{block.text.split("\n").slice(0, 4).join("\n")}</span>;
    case "horizontal_rule":
      return <span className="lf-doc-mini__rule" />;
    case "image": {
      const src = image(block.asset);
      return (
        <span
          className="lf-doc-mini__img"
          style={block.width ? ({ width: `${Math.round(block.width * 100)}%` } as CSSProperties) : undefined}
        >
          {src ? <img src={src} alt="" loading="lazy" /> : null}
        </span>
      );
    }
    case "table":
      return (
        <span className={cx("lf-doc-mini__table", block.header && "has-header")}>
          {block.rows.slice(0, 4).map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed picture of the first rows.
            <span key={r} className="lf-doc-mini__row">
              {row.slice(0, 4).map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed picture of the first cells.
                <span key={c} className="lf-doc-mini__cell">
                  {cell.blocks.map((p) => runsText(p.runs)).join(" ")}
                </span>
              ))}
            </span>
          ))}
        </span>
      );
  }
}

export function DocCover({
  preview,
  markdown,
  fileId,
  tiny = false,
}: {
  /** The server's preview (its first blocks). */
  preview?: DocumentPreview;
  /** Without a preview (an older server), the document's Markdown. */
  markdown?: string;
  fileId: string;
  /** The list's small thumbnail: the page's lines only. */
  tiny?: boolean;
}) {
  const api = useApi();
  const { org } = useOrg();
  const blocks = useMemo(() => {
    const all = preview?.blocks ?? (markdown ? markdownToBlocks(markdown, { images: () => null }) : []);
    return all.slice(0, COVER_BLOCKS);
  }, [preview, markdown]);
  const image = (asset: string) => api.live.assetUrl(org.id, fileId, asset);
  if (tiny) {
    return (
      <div className="lf-cover lf-cover--doc lf-cover--tiny-doc">
        <span className="lf-doc-mini lf-doc-mini--tiny" aria-hidden="true">
          {[70, 94, 88, 62].map((w) => (
            <i key={w} style={{ width: `${w}%` }} />
          ))}
        </span>
      </div>
    );
  }
  return (
    <div className="lf-cover lf-cover--doc">
      <div className="lf-doc-mini">
        {blocks.map((block, i) => (
          <Block key={block.id ?? i} block={block} image={image} />
        ))}
      </div>
    </div>
  );
}
