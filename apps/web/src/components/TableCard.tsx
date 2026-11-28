import { linkPill } from "@agenteschat/client/lib/link-pills";
import { plainInline, type TableAlign } from "@agenteschat/client/lib/markdown";
import { parseFileLink, parseMessageLink } from "@agenteschat/client/lib/message-links";
import {
  linkSite,
  TABLE_PREVIEW_ROWS,
  type TableColumnKind,
  tableCellRead,
  tableColumnKinds,
  tablePreviewed,
  tableTsv,
} from "@agenteschat/client/lib/table";
import { Button, cx, Dialog, DialogBody, Icon, useScrollSides } from "@agenteschat/ui";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SiteIcon } from "@/components/browser/SiteIcon";
import { CopyCode } from "@/components/CodeBlock";
import { useGrowFrom } from "@/lib/grow";
// The site's icon tile in a link cell (`.brw-site-icon`), in a document too, where no browser card loads it.
import "./browser/browser.css";

/** How a cell's Markdown shows as words (the message's or the document's own inline renderer). */
type TableInline = (text: string, key: string) => ReactNode;

/**
 * A Markdown table in a message or a document, in the code card's frame: "Table · N rows" on top with Copy (the cells
 * split by tabs, as a spreadsheet takes them) and Full screen, then the table. Each column lays out by what its cells
 * hold (`tableColumnKinds`, shared with the phone app), so the table fits the width it has before it scrolls: a column
 * that only counts the rows stays narrow, numbers, short words and links stay on one line (a link as its site's icon
 * and name), and only longer text wraps. A wider one scrolls sideways inside the card with its first column standing
 * still (the first two when the first only counts the rows). In a message (`preview`) a long table shows its first
 * rows and ends in "See all N rows"; full screen grows out of the card, as the code card's does, with the header and
 * the first column standing still.
 *
 * The root keeps `md__table`: a bubble widens to hold it and gives it the code card's margins (chat/looks.css), and
 * the wiki editor reads a pasted one back as a table. Its own look is under `.table-card`, so the other tables that
 * use `md__table` (a chart's table view, the wiki editor's) stay as they are.
 */
export function TableCard({
  header,
  rows,
  align,
  inline,
  preview = false,
}: {
  header: string[];
  rows: string[][];
  align: TableAlign[];
  inline: TableInline;
  preview?: boolean;
}) {
  const { t } = useTranslation();
  // From every row, the hidden ones too: the card and its full screen lay the columns out the same way.
  const kinds = useMemo(
    () =>
      tableColumnKinds(
        rows.map((r) => r.map(tableCellRead)),
        header.length,
      ),
    [rows, header.length],
  );
  const tsv = useMemo(
    () =>
      tableTsv(
        header.map(copiedCell),
        rows.map((r) => r.map(copiedCell)),
      ),
    [header, rows],
  );
  const cut = preview && tablePreviewed(rows.length);
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const remember = useGrowFrom(open, card, ".table-viewer");
  const expand = () => {
    remember();
    setOpen(true);
  };
  const grid = { header, align, kinds, inline };

  return (
    <div className="md__table table-card" ref={card}>
      <div className="table-card__top ac-actline">
        <span className="table-card__label">{t("common.tableRows", { count: rows.length })}</span>
        <span className="ac-acts">
          <CopyCode text={tsv} />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="expand"
            aria-label={t("common.fullScreen")}
            title={t("common.fullScreen")}
            onClick={expand}
          />
        </span>
      </div>
      <TableScroll {...grid} rows={cut ? rows.slice(0, TABLE_PREVIEW_ROWS) : rows} />
      {cut && (
        <button type="button" className="table-card__more" onClick={expand}>
          {t("common.tableSeeAll", { count: rows.length })}
          <Icon name="chevronRight" size={16} inline />
        </button>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("common.table")}
        subtitle={t("common.tableRowCount", { count: rows.length })}
        closeLabel={t("common.close")}
        width={1100}
        className="table-viewer"
        actions={<CopyCode text={tsv} />}
      >
        <DialogBody className="table-viewer__body">
          <TableScroll {...grid} rows={rows} />
        </DialogBody>
      </Dialog>
    </div>
  );
}

/**
 * The table inside its box, in the card and in full screen alike: it scrolls sideways under its standing columns
 * (`position: sticky`, measured so the second stands at the first's width and a column snaps in right after them),
 * with a hairline on their edge while columns pass under them and a fade on the side that still hides some
 * (`data-more`, from `useScrollSides`). The fade is drawn over the table in the card's color, not a mask: a mask
 * would fade the standing column too.
 */
function TableScroll({
  header,
  rows,
  align,
  kinds,
  inline,
}: {
  header: string[];
  rows: string[][];
  align: TableAlign[];
  kinds: TableColumnKind[];
  inline: TableInline;
}) {
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const more = useScrollSides(scroller);
  // A column that only counts the rows says nothing alone: the column after it stands with it. One column, or two
  // with the count, have nothing to pass under them.
  const stick = header.length > 2 && kinds[0] === "index" ? 2 : header.length > 1 ? 1 : 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: again when it starts or stops overflowing (its scrollbar)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const standing = Array.from(el.querySelectorAll<HTMLElement>("thead th")).slice(0, stick);
    const measure = () => {
      el.style.setProperty("--table-card-stick", `${standing[0]?.offsetWidth ?? 0}px`);
      el.style.scrollPaddingLeft = `${standing.reduce((w, th) => w + th.offsetWidth, 0)}px`;
      // The fade stops above our scrollbar, which it would otherwise cover at its end.
      box.current?.style.setProperty("--table-card-bar", `${Math.max(0, el.offsetHeight - el.clientHeight)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    for (const th of standing) resize.observe(th);
    return () => resize.disconnect();
  }, [stick, more]);

  const cell = (j: number) => cx(j < stick && "table-card__stick", j === stick - 1 && "table-card__edge") || undefined;
  const side = (j: number) => (kinds[j] === "index" ? "right" : align[j]);

  return (
    <div ref={box} className="table-card__body" data-more={more}>
      <div ref={scroller} className="table-card__scroll">
        <table>
          <thead>
            <tr>
              {header.map((h, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static table
                <th key={j} className={cell(j)} data-kind={kinds[j]} style={{ textAlign: side(j) }}>
                  {inline(h, `h${j}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static table
              <tr key={i}>
                {header.map((_, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static table
                  <td key={j} className={cell(j)} data-kind={kinds[j]} style={{ textAlign: side(j) }}>
                    {kinds[j] === "link" ? (
                      <LinkCell raw={r[j] ?? ""} inline={inline} k={`${i}-${j}`} />
                    ) : (
                      inline(r[j] ?? "", `${i}-${j}`)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-card__fade" aria-hidden="true" />
    </div>
  );
}

const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
const ADDRESS = /^<?(https?:\/\/[^\s<>]+)>?$/i;
/** Words that are an address themselves ("https://…", "www.…"): the cell shows the site's name instead. */
const ADDRESS_WORDS = /^(https?:\/\/|www\.)/i;

/** A cell that is nothing but a link: its address and the words written for it (the address itself when bare). */
function cellLink(raw: string): { href: string; words: string } | null {
  const cell = raw.trim();
  const link = cell.match(LINK);
  if (link) return { href: link[2] ?? "", words: link[1] ?? "" };
  const bare = cell.match(ADDRESS);
  return bare ? { href: bare[1] ?? "", words: bare[1] ?? "" } : null;
}

/** A cell as Copy takes it: its words without marks; a bare address stays whole, it is what a sheet needs. */
function copiedCell(raw: string): string {
  const link = cellLink(raw);
  return link && link.words === link.href ? link.href : plainInline(raw.trim());
}

/**
 * A cell of a links column (`link`): an address shows as its site's icon and name ("shop.example.com", without
 * "https://", "www." or the path), a link with words of its own as those words, on one line that ends in "…" when it
 * is long; it opens the whole address, which its tip shows. A link to a message or a file here, or a known service's
 * address (a pull request, a document), keeps its pill, which says more than a site's name; any other cell shows as
 * written.
 */
function LinkCell({ raw, inline, k }: { raw: string; inline: TableInline; k: string }) {
  const link = cellLink(raw);
  const site = link ? linkSite(link.href) : null;
  if (!link || !site) return <>{inline(raw, k)}</>;
  const bare = link.words === link.href || ADDRESS_WORDS.test(link.words.trim());
  const here = [window.location.origin];
  if (parseMessageLink(link.href, here) || parseFileLink(link.href, here) || (bare && linkPill(link.href)))
    return <>{inline(link.words === link.href ? link.href : raw, k)}</>;
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className="table-card__link" title={link.href}>
      <SiteIcon host={new URL(link.href).host.toLowerCase()} />
      <span className="table-card__site">{bare ? site : plainInline(link.words)}</span>
    </a>
  );
}
