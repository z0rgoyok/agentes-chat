# 0240. Channels in sectors

- Status: Accepted. Amended 2026-11-27 by ADR 0260: §6 to §9, sectors leave the sidebar (a channel keeps its sector, on
  Equipe › Setores and in the pickers); channel sections are each person's own
- Date: 2026-11-25
- Amends: ADR 0080 (channel categories go away; their placing rules move to sectors), ADR 0083 and its 2026-11-04
  amendment (a sector holds channels as well as agents)
- Code: db `packages/db/src/schema/chat.ts` (`channels.group_id`, migration `0352_channels_in_sectors`); engine
  `channel-sectors.ts` (`placeChannel`, `endOfSector`, `channelsInSector`), `channels.ts` (`createChannel`,
  `listChannels`), `agent-groups.ts` (`createAgentGroup` with `channelIds`, `deleteAgentGroup`, `listAgentGroups`);
  server `routes/app/channels.ts`, `chat.ts`, `agents.ts`; client `api/queries.ts` (`usePlaceChannel`,
  `useAgentGroupAction`, `agentGroupsQuery`), `realtime/machines.ts`; web `Sidebar.tsx` (`useSidebarChannels`),
  `SectorSelect.tsx`, `AgentGroups.tsx`; phone `features/channel-sectors/*`, `features/chats/logic.ts`
  (`sectorSections`, `keptWhenClosed`, `closedUnread`), `ChatsScreen.tsx`, `HomeSection.tsx`

## Context

A workspace with many agents and channels had two groupings side by side: sectors (agent groups) holding agents, and
channel categories holding channels, often with the same names. Suporte, Vendas and Financeiro each showed twice in
the sidebar, once for the agents and once for the channels, and moving a team meant arranging both.

## Decision

1. **A channel belongs to at most one sector.** `channels.group_id` points at `agent_groups` (on delete, set null);
   `channels.position` is its order inside the sector, or among the channels in none, as it was inside a category.
   Channel categories go away: no screen, route or API creates, renames, orders or deletes them.
2. **Migration 0352.** Each channel category joins the sector of the same name in its workspace, ignoring case, or
   becomes a new sector after the others, in the categories' order, each new one in the next of the roles' colors.
   Its channels move there with their order. `channel_categories` and `channels.category_id` stay in the database,
   read by nothing, until a later migration drops them once no running version reads them. Older phone builds still
   ask for `GET …/channel-categories`: it answers an empty list.
3. **Who moves a channel.** As before: who manages channels, and the channel's creator still in it
   (`managesChannel`). `PUT …/channels/{id}/place` takes `{ groupId, beforeChannelId }`; `POST …/channels` takes a
   `groupId`. A new sector is made by who manages agents (ADR 0083), and `POST …/agent-groups` takes `channelIds`,
   each one the caller may move ("Novo setor com #canal"). Deleting a sector sends its channels to the end of the
   ones in none, in their order.
4. **Who sees a sector.** `listAgentGroups` keeps a sector for someone who doesn't list every agent when it holds an
   agent they list or a channel they see (public, theirs, or limited to a role they hold). A sector of private
   channels they're not in stays out of their list.
5. **Live.** A move still sends the org broadcast `channels.layout`; a sector change still sends `agent.groups`. Every
   app reads both the channels and the sectors again on either (`applyWorkspaceEvent`).
6. **The web sidebar.** Canais holds the channels in no sector, its + is Novo canal. Each sector shows its agents, a
   hairline, then its channels, the pinned ones of each first. A channel's right click has "Mudar de setor" as an
   agent's has (Sem setor and every sector, its own dimmed, then "Novo setor com #canal" for who makes sectors), and a
   channel dragged onto a sector's header or into its body goes to its end, with a toast and Desfazer; dragged onto a
   row it takes that place. Criar canal and the channel's details pick a sector once the workspace has one.
7. **Closed.** A closed sector stays one line but keeps in sight its agents at work or that wrote to me and its unread
   channels (ADR 0083 §7), and one count, the unread of its agents' DMs and its channels, takes the place of its agent
   count.
8. **Marks.** A sector's mark in the sidebar shows its own color and icon (no gray filter), and a new sector starts in
   a color no other sector has, so the marks tell sectors apart.
9. **The phone.** Conversas' Setores lists each sector's agents, a hairline, then its channels; the channels in none
   stay in Canais; the closed rule of §7 holds. A channel's long press ("Mudar de setor") and its ⋯ sheet ("Setor")
   open one screen: Sem setor or a sector, "Novo setor com #canal" for who makes sectors, and its place in the list.

## Consequences

- Who manages channels but not agents moves channels between existing sectors but no longer creates a grouping:
  categories were theirs, sectors belong to who manages agents.
- A workspace that used categories and sectors with different names ends with more sectors. Sectors with no agents
  and no channels show only to who arranges them.
- Equipe › Setores lists a sector's own channels before the ones its agents are in.
