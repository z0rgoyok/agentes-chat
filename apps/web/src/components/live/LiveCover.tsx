import type { ArtifactContent, ArtifactLiveContent, LivePresent, PresenceSummary } from "@agenteschat/client";
import { useApi, useLivePresence } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { colName } from "@agenteschat/live";
import { type SlidesPreview, THEMES } from "@agenteschat/live/slides";
import {
  booleanFromText,
  booleanText,
  errorFromText,
  errorText,
  type SheetLocale,
  type SheetPreview,
  sheetLocale,
} from "@agenteschat/live/spreadsheet";
import { AvatarStack, cx } from "@agenteschat/ui";
import { type CSSProperties, createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { CanvasMini } from "./canvas";
import { DocCover } from "./document/DocCover";
import { PeerFace, usePeerLooks } from "./peers";
import { SlideThumb } from "./slides";
import "./covers.css";

/**
 * Live files drawn small (ADR 0196 §7, §9), from the preview the server keeps with each file: a spreadsheet's first
 * cells on its grid, a presentation's first slide, a canvas's map, a document's first page (ADR 0200); and the faces
 * of who is in the file now. The Drive's cards and rows (`DrivePreview`) and the cards in messages (`ArtifactCard`)
 * draw these.
 */

export type LiveCoverSize = "sm" | "md" | "lg" | "tile";

/** The faces a cover shows before it stops (who else is in the file). */
export const HERE_FACES = 3;

/** Who is in each of the files on screen, asked once for all of them (the Drive's page). */
const PresenceContext = createContext<{ ids: ReadonlySet<string>; summary: PresenceSummary | undefined } | null>(null);

/**
 * Asks who is in the live files among `ids` in one request for the whole page (refreshed every 15 seconds and when a
 * conversation says someone came or left); the covers inside read from it.
 */
export function LivePresenceScope({ ids, children }: { ids: readonly string[]; children: ReactNode }) {
  const { org } = useOrg();
  const query = useLivePresence(org.id, ids);
  const value = useMemo(() => ({ ids: new Set(ids), summary: query.data }), [ids, query.data]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

/** Who is in the file now, but the person reading (a page's scope, else a request of its own). */
export function useHere(fileId: string): LivePresent[] {
  const { org, me } = useOrg();
  const scope = useContext(PresenceContext);
  const inScope = Boolean(scope?.ids.has(fileId));
  const own = useLivePresence(org.id, inScope ? [] : [fileId], { enabled: !inScope });
  const list = (inScope ? scope?.summary : own.data)?.[fileId] ?? [];
  return list.filter((p) => !(p.kind === "person" && p.id === me.user.id));
}

/** Up to three faces of who is in the file now (an agent's alive while it edits), at the cover's bottom right. */
export function HereFaces({ fileId, className }: { fileId: string; className?: string }) {
  const { t } = useTranslation();
  const here = useHere(fileId);
  const looks = usePeerLooks();
  if (here.length === 0) return null;
  const label = t("live.shell.presence.inNow", {
    names: joinNames(
      here.map((p) => looks(p).name),
      t,
    ),
  });
  return (
    <AvatarStack className={cx("lf-here", className)} role="img" aria-label={label}>
      {here.slice(0, HERE_FACES).map((p) => {
        const look = looks(p);
        return (
          <PeerFace
            key={`${p.kind}:${p.id}`}
            user={{ kind: p.kind, id: p.id }}
            name={look.name}
            size="xs"
            working={p.kind === "agent" && p.mode === "editing"}
          />
        );
      })}
    </AvatarStack>
  );
}

/** What a live file's cover draws from: a kind's preview, or a document's (ADR 0200). */
export type LiveCoverContent = ArtifactLiveContent | Extract<ArtifactContent, { kind: "document" }>;

/** A live file's cover: what it holds, drawn small, and who is in it now. */
export function LiveCover({
  content,
  fileId,
  size = "md",
  here = true,
}: {
  content: LiveCoverContent;
  fileId: string;
  size?: LiveCoverSize;
  /** The faces of who is in it (off where the row shows them itself, or the box is too small). */
  here?: boolean;
}) {
  const body =
    content.kind === "document" ? (
      <DocCover preview={content.preview} markdown={content.markdown} fileId={fileId} tiny={size === "sm"} />
    ) : content.kind === "spreadsheet" ? (
      <SheetCover preview={content.preview} tiny={size === "sm"} />
    ) : content.kind === "slides" ? (
      <SlidesCover preview={content.preview} fileId={fileId} />
    ) : (
      <div className="lf-cover lf-cover--canvas">
        <CanvasMini preview={content.preview} fileId={fileId} />
      </div>
    );
  return (
    <>
      {body}
      {here && size !== "sm" && <HereFaces fileId={fileId} />}
    </>
  );
}

// ── Spreadsheet ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rows and columns a cover draws at most (what the preview keeps: 12 by 8). */
const SHEET_ROWS = 12;
const SHEET_COLS = 8;
const DEFAULT_WIDTH = 100;

/** A number as English writes it ("1,234.5", "-12%", "R$ 1,234.00", "(7.25)"): its digits, signs and symbols. */
const EN_NUMBER = /^([^\d\s.,+\-−(]{0,4}\s?)?([(+\-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([)%]?)(\s?[^\d\s.,]{0,4})?$/;

/**
 * A cell's text from the preview (the server writes it as English shows it) as the reader's language shows it: a
 * number's separators ("1,234.5" → "1.234,5" in Portuguese), TRUE and FALSE, and errors ("#N/A" → "#N/D"). Dates and
 * words stay as they are.
 */
export function relocalize(text: string, locale: SheetLocale): string {
  const shown = text.trim();
  if (!shown) return text;
  const error = errorFromText(shown);
  if (error) return errorText(error, locale);
  const bool = booleanFromText(shown);
  if (bool !== null && /^(true|false)$/i.test(shown)) return booleanText(bool, locale);
  if (locale.decimal === "." && locale.group === ",") return text;
  const m = EN_NUMBER.exec(shown);
  if (!m) return text;
  const [, before = "", sign = "", whole = "", fraction = "", after = "", tail = ""] = m;
  const digits = whole.replace(/,/g, locale.group);
  const decimals = fraction ? `${locale.decimal}${fraction.slice(1)}` : "";
  return `${before}${sign}${digits}${decimals}${after}${tail}`;
}

/**
 * A spreadsheet's first cells on its own grid, as it shows them: the column letters and row numbers, the cells' words
 * in the reader's language, bold and aligned as they are, the columns in their widths. The list's small thumbnail
 * draws the grid's lines only.
 */
function SheetCover({ preview, tiny }: { preview: SheetPreview; tiny: boolean }) {
  const { i18n } = useTranslation();
  const locale = useMemo(() => sheetLocale(i18n.language), [i18n.language]);
  if (tiny) return <div className="lf-cover lf-cover--sheet lf-cover--tiny" />;
  const rows = Math.max(SHEET_ROWS, preview.rows.length);
  const cols = Math.max(SHEET_COLS, preview.widths.length);
  const widths = Array.from({ length: cols }, (_, c) => preview.widths[c] ?? DEFAULT_WIDTH);
  return (
    <div className="lf-cover lf-cover--sheet">
      <table className="lf-mini-grid">
        <colgroup>
          <col className="lf-mini-grid__num" />
          {widths.map((w, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid of columns.
            <col key={c} style={{ "--w": String(w) } as CSSProperties} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="lf-mini-grid__corner" />
            {widths.map((_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid of columns.
              <th key={c}>{colName(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid of rows.
            <tr key={r}>
              <th>{r + 1}</th>
              {widths.map((_, c) => {
                const text = preview.rows[r]?.[c] ?? "";
                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid of cells.
                    key={c}
                    className={preview.bold[r]?.[c] ? "is-b" : undefined}
                    data-align={preview.align?.[r]?.[c] ?? undefined}
                  >
                    {text ? relocalize(text, locale) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Slides ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The width of an element, followed as it changes (0 until known). */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** A presentation's first slide, itself drawn small (never a picture of it), on the cover's sunken ground. */
function SlidesCover({ preview, fileId }: { preview: SlidesPreview; fileId: string }) {
  const api = useApi();
  const { org } = useOrg();
  const [ref, width] = useWidth<HTMLDivElement>();
  const first = preview.first;
  // An empty deck still shows its theme's ground.
  const ground = (THEMES[preview.theme] ?? THEMES.sky).colors.bg;
  return (
    <div className="lf-cover lf-cover--slides">
      <div ref={ref} className="lf-cover__slide" style={{ background: ground }}>
        {first && width > 0 ? (
          <SlideThumb
            slide={first}
            theme={preview.theme}
            width={width}
            imageUrl={(asset) => api.live.assetUrl(org.id, fileId, asset)}
          />
        ) : null}
      </div>
    </div>
  );
}
