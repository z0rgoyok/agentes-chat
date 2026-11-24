# 0202. Who sees and who edits a file: people, roles and agents

- Status: Accepted (built)
- Date: 2026-11-18
- Extends: 0157 (who sees a file), 0196 (live files), 0199 (a file's conversation), 0200 (documents)
- Amends: 0157 (Compartilhar sets a level per row, not only who sees), 0196 ("whoever reads a live file edits it" now
  holds only while nobody limits it)
- Code: engine `packages/engine/src/artifacts.ts` (`AccessLevel`, `personEdits`, `agentLevel`, `canRead`, `writable`,
  `viewOnlyForAgent`, `liveFileAccess`, `artifactScope`, `accessOf`, `FileAccess`, `withPersonFacts` with `myAccess`,
  `setFileAccess`); server `routes/app/artifacts.ts` (`PUT …/artifacts/{id}/access`, `access` and `myAccess` on
  `Artifact`), `realtime/live.ts` (`sharingKey` with the editors, so open sockets follow a change); client
  `api/types.ts` (`ArtifactAccess`, `ArtifactAccessRow`, `AccessLevel`), `api/client.ts` and `http-client.ts`
  (`artifacts.setAccess`), `api/queries.ts` (`useSetArtifactAccess`), `lib/errors.ts` (`artifact.view_only`,
  `artifact.access_invalid`); UI `packages/ui/src/components/AccessDialog.tsx` (`readOnly`); web
  `components/artifacts/ShareDialog.tsx`, `components/live/LiveHeader.tsx` and `LiveFilePage.tsx` (Pedir para
  editar); phone `features/files/ShareSheet.tsx`, `features/live-files/shared/LiveBar.tsx`; migration
  `0312_file_access.sql`; tests `packages/engine/test/file-access.test.ts`, `apps/web/test/file-sharing.test.tsx`

## Context

ADR 0157 let a file be seen beyond its conversation, and ADR 0196 made seeing a live file the same as editing it. That
is the right start for a team's working file and the wrong one for a budget everyone should read and three people
should change, a report an agent should read but never touch, or a plan only one agent should keep up to date. Agents
had no rule of their own: an agent edited a file because it was in the file's conversation, and a file of the Drive
itself reached every agent.

## Decision

1. **Three levels, one list.** Compartilhar is the wiki's access list (the shared `AccessDialog` on the web,
   `AccessList` on the phone): every row has a level, `none`, `view` or `edit`. Three rows are always there:
   - who reads it where it lives (a conversation's members, `view` or `edit`); for a file of the Drive itself, its
     maker instead, who always edits;
   - the whole workspace (`none`, `view` or `edit`), left out for a public channel's file, which the workspace reads
     already;
   - the agents (`none`, `view` or `edit`): every agent of the workspace for a Drive file, the agents where it lives
     for a conversation's file.

   Then people, roles and agents added one by one, each to `view` or `edit`. As the wiki: while a base row edits, the
   rows under it say nothing and adding one drops that base to `none`, in plain sight, until Salvar; while it views,
   a row can only be "this one edits too".
2. **Who always edits.** The person who made the file, the workspace's administrators (as for who sees, ADR 0157)
   and the agent that made it, wherever it reaches the file (§5). Nobody else is above the list.
3. **What is kept.** Who sees stays `share`, `share_user_ids` and `share_role_ids` (ADR 0157), derived from the rows.
   Beside them, on `artifacts`: `editors_limited` (someone who sees it only views), `editor_user_ids`,
   `editor_role_ids`, `conversation_edits` (its conversation edits), `agent_base` and the named agents
   `agent_view_ids` and `agent_edit_ids` (migration 0312). A file nobody has set levels on keeps its rule:
   `editors_limited` false (whoever sees it edits) and `agent_base` null (an agent where it lives edits; a Drive file
   reaches agents as before). `accessOf` reads the columns back as the list the apps draw.
4. **One gate for writes.** `writable` is the check every change goes through (a new version, a live file's socket,
   an agent's tools). A person who only views gets 403 `artifact.view_only`; an agent gets the same code with words
   that tell it to ask who made the file for edit access instead of trying another way. `liveFileAccess` opens a live
   file in view mode for who only views, and the live socket's recheck includes the editors, so a change of level
   reaches sockets already open.
5. **Agents.** Agents never widen who sees a file (ADR 0157): `agentLevel` gives an agent a level only where it
   reaches the file, by where it lives or for the person behind its run, so naming an agent never lets it open a file
   for someone who can't. There, the agent that made it, or one named to edit, edits; one named to view, views;
   `agent_base` `none` closes the file to every other agent, which neither opens it nor finds it in lists and search
   (`artifactScope`); otherwise the base applies to every agent for a Drive file and to the agents where it lives for
   a conversation's file. An agent elsewhere, asked by someone who reads a conversation's file, reads it, never edits.
6. **Who changes it.** `PUT …/artifacts/{id}/access` (`setFileAccess`): someone who reads the file where it lives and
   edits it; for a Drive file, its maker or an administrator. Others get 403 `artifact.sharing_forbidden`, and the
   apps show them the list as it is, read-only. Levels outside the three are 400 `artifact.access_invalid`; people,
   roles and agents not of the workspace are dropped. The change is audited (`artifact.access_changed`).
7. **Asking for more.** A person who only views a live file sees Pedir para editar beside the file's read-only mark.
   It opens the file's conversation (ADR 0199) with a message ready to send that mentions its maker, or asks anyone
   there when no person made it. The mention is the notification: no new kind of request.

## Consequences

- The apps get each file's `access` (the list) and `myAccess` (`view` or `edit` for the person asking), so they never
  offer an edit the server would refuse.
- `PUT …/artifacts/{id}/sharing` stays for phone builds already installed: it changes who sees, never the levels.
- A role's or a conversation's members change who edits without touching the file, as they already changed who sees.

## Rejected

- **A separate "Editors" list beside "Who sees".** Two lists to keep in step, and the wiki already taught people one.
- **A request kind of its own for edit access.** The file's conversation and a mention already reach its maker, with
  the context of the file; a new inbox item would say less.
