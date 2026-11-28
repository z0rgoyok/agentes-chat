# 0259. Tables in messages fit before they scroll, in the code card's frame; message text with a rhythm

- Status: Accepted
- Date: 2026-11-27
- Code: `packages/client/src/lib/table.ts` (`tableColumnKinds`, `tableCellRead`, `linkSite`, `tableTsv`, `TABLE_PREVIEW_ROWS`, `tablePreviewed`), web `apps/web/src/components/TableCard.tsx`, `apps/web/src/lib/markdown.tsx`, `apps/web/src/layout.css` (`.table-card`, `.table-viewer`, `.md--message`), phone `apps/mobile/src/features/chat/MessageSpans.tsx` (`Table`), `TableCard.tsx` (`TableCard`, `TableScreen`, route `/table`), `logic.ts` (`fitTableColumns`, `blockGap`, `TEXT_RHYTHM`), `MessageText.tsx`, `MessageRow.tsx` (`wideBubble`)

## Context

Agents answer with Markdown tables more and more: suppliers, prices, people, results. On a phone a table took its message's width and each column grew up to 280 points, so a table of three columns showed two and cut the third in the middle of a word, with nothing saying it scrolled. The web fitted a little better but showed a bare address in full, ran its header on a band, faded the whole edge (a standing column could not exist) and had no way to read a long table whole or take it to a spreadsheet. Code already had a card with Copy and Full screen; tables had none.

A message's text had one gap for everything on the phone (8 points between a paragraph, a list item and a heading alike), a heading at the text's size, a heavy bold and code with no plate; on the web a quote still had a bar on its left edge.

## Decision

1. **The code card's frame.** A Markdown table in a message or a document is a card like the code card: the same corners, hairline and 38-point head, which reads "Table · N rows" with Copy and Full screen. Its header has no band: faint words over a hairline. Rows are split by hairlines, numbers stay on the right in tabular figures.
2. **Columns by what they hold** (`tableColumnKinds`, shared). The first column of counts ("#", 1, 2, 3…) is an `index`: narrow and faint. A column whose cells are mostly a single link is a `link`: each cell shows its site's icon and name (`linkSite`: no scheme, `www.` or path), or the link's own words, on one line cut at its end, and opens the full address. Numbers with a short unit are `number`, cells of up to 18 letters `short`; neither wraps. Anything longer is `text`, which wraps at its words. A message's or a file's link, and a known service's address, keep their pill.
3. **Fit before scroll.** Each column starts at its widest cell. With room to spare the text columns take it, so rows run the card's width. Too wide, the text columns give way first (down to 120 points on the phone, 160 px on the web), then the links (down to 112 points); counts, numbers and short words never do. Only a table that still can't fit scrolls sideways (on the phone `fitTableColumns`; on the web the browser's table layout with those minimums).
4. **Scrolling sideways.** The first column stands still (the one after a count too), with a hairline at its edge once the rest has moved under it. A scroll comes to rest where a column starts, after the standing ones. The side that hides columns fades into the card's color. On the phone all of it follows the scroll on the UI thread.
5. **Long tables.** In a message, a table with more than ten rows shows eight and ends with "See all N rows", as long code ends with "See all N lines". That and Full screen open the whole table: on the web a dialog that grows from the card, on the phone a pushed screen with the system's back (`/table`) that turns with the phone (the app stands upright everywhere else, ADR 0212). Both keep the header and the standing column still. Documents show every row.
6. **Copy** takes the table as a spreadsheet takes it from the clipboard (`tableTsv`): cells split by tabs, rows by line breaks, so each value lands in its own cell; an address alone in a cell is copied whole.
7. **Room on the phone.** In the bubbles look, someone else's bubble that holds a table or code reaches the screen's margin (16 points), as the web's bubble takes its full width.
8. **A message's text** (the web's `.md--message`, the phone's `MessageText`): 12 between blocks, a list's items 6 apart and 8 under the sentence that opens them, a heading a step over the words with 20 above and 4 below. Numbered lists draw their numbers faint and tabular, right aligned before the words; the phone takes the web's small square marker. A quote is a plate with no bar. On the phone bold is 600 and inline code sits on the plate; on the web a link in a sentence keeps the sentence's weight.

## Consequences

- A three-column table reads whole on a phone; a wide one keeps its first column in view, and any table goes to a spreadsheet in one tap.
- Kinds are read from the cells, so a column of short names written as text stays on one line even when a longer header wraps above it; a column of mixed long and short text wraps as text.
- The chart's table view keeps its own box (`TableBox` on the web) but, on the phone, shares the fitted columns and the standing column of `Table`.
