# 0260. The sidebar: a tool column, the familiar list, each person's own sections

- Status: Accepted
- Date: 2026-11-27
- Amends: ADR 0240 §6 to §9 (sectors leave the sidebar; a channel's sector stays, on Equipe › Setores and in the
  sector pickers), ADR 0080 §1 and §6 (channel sections come back, each person's own), ADR 0083 §5 and §7 and their
  amendments (no Agentes part: agents sit in Mensagens diretas; "Fixar no topo" becomes Favoritos), ADR 0218 (the
  inbox's tool leaves the sidebar: what waits for the person is in Não lidas)
- Code: engine `packages/engine/src/sidebar-items.ts` (`SidebarView.favorites`, `.sections`, `.dms`,
  `sidebarViewOf`, `setMySidebarView`); db migration `0366_sidebar_sections`; server `routes/app/management.ts`
  (`SidebarView`); client `lib/sidebar-view.ts` (`favoritesOf`, `toggleFavorite`, `placeInSection`, `addSection`,
  `renameSection`, `removeSection`, `moveSectionBy`, `moveChannelBy`), `lib/recent.ts` (`dmList`); web `Sidebar.tsx`
  (the column, `useChannelSections`, `SidebarChannels`, `SectionNameField`, `InviteRow`), `hooks/useSidebarPins.ts`
  (`useSidebarFavorites`), `pages/UnreadsPage.tsx`, `routes/org.$orgId.unreads.tsx`, `layout.css`; ui `title-tips.ts`
  (`data-tip-side="right"`); phone `features/chats/pins.ts`, `logic.ts` (`pinnedRows`, `sectorSections`),
  `ChatsScreen.tsx`, `PinnedStrip.tsx`, `features/channel-sectors/PickSectorScreen.tsx` (Seção), `menus.tsx`

## Context

The sidebar had grown to seven tool rows on top, a part per sector holding its agents and its channels (ADR 0240),
an Agentes part, pins inside each part, and Mensagens diretas for people only. Channels started about 370px down. The
team asked for the layout people already know from team chat apps: the tools out of the list, then Não lidas, Threads,
Favoritos, Canais and Mensagens diretas, people and agents together, with channel groups only for someone who wants
them. Sectors grouped agents and channels for the whole workspace, so one person's arrangement reshuffled everyone's
list.

## Decision

1. **A tool column.** A team workspace's sidebar (web and the desktop app) is a 64px column at its left edge and the
   list beside it. The column has Ir para… (⌘K) on top, a line, Início, the tools the person keeps in sight
   (Personalizar's places, ADR 0159), Mais, and at its foot Agora and the collapse. Each tool is a 40px tile, icon
   only, its name in a tip on its right on hover and keyboard focus; the column is a vertical `toolbar` (arrow keys
   move between tiles). A tile's mark is a dot: ink for something unread, red for something for the person (a
   mention, something waiting). Collapsing hides the list and keeps the column; a tablet shows the column and its
   toggle opens the list over the page; a phone's drawer holds both. A personal workspace (ADR 0159) keeps its own
   layout.
2. **The usual order.** The list holds the workspace's header, then Não lidas, Threads, Favoritos, Canais and Mensagens
   diretas. The inbox's tool leaves the column (Não lidas holds what waits for the person, §6) and Threads moves into
   the list. No Agentes part and no sectors: sectors keep their agents, channels, colors, lead and backup on Equipe ›
   Setores and in the sector pickers, and show nowhere in the list. No colored marks in the list.
3. **Favoritos.** People, agents and channels, each by name on one line, in the person's order. A row's menu adds
   or removes it ("Adicionar aos favoritos"); a favorite leaves the part it would sit in otherwise. Alt+Shift+↑/↓ or
   dragging reorder them. At most 50. Stored as `view.favorites` (`agent:<id>`, `channel:<id>`, `person:<user id>`);
   never saved, it starts from the pins of before (the agents, the people, then the channels, in their order), else
   from the person's own agents (day one, as ADR 0083's pins did).
4. **Canais and each person's own sections.** Canais is one list, in the workspace's channel order (ADR 0080 §3),
   then the person's sections. Sections are each person's own (`view.sections`), none by default. A channel dragged
   onto a channel in none makes a section of both, its name field open and selected; dragged onto a section's header
   or onto a channel in a section it moves there; dragged onto Canais' header it goes back. The keyboard's way is the
   row's menu ("Mover para a seção": each section, Nova seção, Tirar da seção) and Alt+Shift+↑/↓, which moves a
   channel inside its section and a section among the others. A section opens and closes (closed, it keeps its
   unread channels and the open one in sight); its menu renames it, moves it and deletes it (its channels go back to
   Canais). A section with no channel left goes away. Migration 0366 starts everyone in a workspace whose sectors hold
   channels with one section per such sector, its name and order, holding the channels the person sees.
5. **Mensagens diretas.** People and agents together, one line each with the same 24px face and a quiet "IA" tag on
   agents: everyone in the workspace (a new member shows at once, an invitation not accepted yet as the invited
   address with "Convite enviado"), and every agent that talks to the person (who manages agents may list the rest,
   as before). The right hand first, then by the DM's latest message, then by name. Its menu shows everyone or only
   the conversations had (`view.dms`, default everyone). Convidar pessoas and Novo agente close the part, for who may.
6. **Não lidas** (`/org/$orgId/unreads`) is one place for everything waiting for the person: the inbox's items that
   wait for them or arrived unread today (approvals, questions, mentions, notices; each opens where the inbox opens
   it), then every channel and DM with unread messages, mentions and DMs first, each with its unread messages, an
   Abrir and a Marcar como lida, and Marcar tudo como lido. The inbox page stays (links, pushes, "Ver tudo").
7. **The usual marks.** An unread channel is bold with no count; a red count only for mentions and DMs. A muted
   channel rests dim. An agent at work shows it in its face alone (it moves, with its orbit): no light behind its row,
   which read as the row chosen.
8. **The phone.** Conversas' strip of pins becomes Favoritos, reading and changing the same `view.favorites` in its
   order; its grouped view (Seções) lists the person's own sections, then the channels in none, then the DMs, with no
   sector's mark. A conversation's long press and swipe add it to Favoritos or take it off, and a channel's long press
   and ⋯ sheet open Seção, a pushed screen: Sem seção and the person's sections, Nova seção (named in a sheet) and its
   place in its section. The native patterns stay.

## Consequences

- Who manages channels no longer arranges the workspace's list for everyone: each person groups their own. The
  workspace's channel order (`channels.position`, `PUT …/place`) still orders Canais for everyone.
- `pins` stays in the view, read only to start Favoritos, so an app built before this keeps working; a view sent
  without `favorites`, `sections` or `dms` keeps the stored ones (`setMySidebarView`).
- Strings removed with ADR 0240 for channel sections come back, with Não lidas, Favoritos, Nova seção, IA, Convidar
  pessoas and Convite enviado, in the 14 languages.
