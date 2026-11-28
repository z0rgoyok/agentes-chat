# 0218. One inbox

- Status: Accepted
- Date: 2026-11-22
- Extends: ADR 0172 (what waits on me: one count, one list), ADR 0071 (a click on a notification opens it as the
  inbox does)
- Code: web `apps/web/src/pages/NotificationsPage.tsx` (`InboxRow`, `InboxRead`, `ProposalRow`, `RequestRead`, the
  filter menu), `apps/web/src/hooks/useInboxWaiting.ts`, the routes `org.$orgId.notifications.tsx`, `…waiting.tsx`
  and `…approvals.tsx`, the sidebar's entry (`Sidebar.tsx`, `SidebarSetup.tsx`, `sidebar-items.ts` in the client and
  the engine); phone `apps/mobile/src/features/activity/ActivityScreen.tsx` (`WaitingRow`, `DecidedRequests`),
  `OpenItem.tsx`, `QuestionScreen.tsx`, `apps/mobile/src/features/approvals/ApprovalSheet.tsx`

## Context

Three places showed nearly one list. Notifications listed everything that involved a person, with what waits on
them on top. "Waiting on you" was that page with one filter fixed. Approvals listed the requests again, with their
history and a review beside them. The sidebar had an entry for each, plus a bell, each with a count of its own, and a
person had to learn which of the three a thing was in. The list itself was a pile of cards, each with its own
buttons, so a few waiting items filled the screen.

## Decision

1. **One place.** The inbox is the notifications' page. The pages for what waits and for approvals are gone: their
   addresses open the inbox on the matching filter, or on the request a link names (`?approval=<id>`), so links in
   pushes and emails already sent still land.
2. **A list and what is open.** The list has no cards and no buttons: who, what they want in one line, what it is
   about under it, and when (for an approval, how long is left). The open item reads beside it, with the agent on its
   own sky, and is answered there. An approval and a question are the conversation's own cards drawn flat, so
   approving (held, for high risk), "always", refusing with a reason and answering behave as they do in the chat.
   Anything else says who, where and what, shows the replies it groups, and replies or opens from there. On a narrow
   screen the list and the open item show one at a time.
3. **One filter menu.** The filters are a menu beside the title, with "Mark all as read", "Clear all" and the keys.
   "Decided requests" is new: the requests already approved, refused or expired, from the approvals' own list, each
   opening with how it ended.
4. **Proposals are rows.** Each proposal a person may decide is a row among what waits, opening with why and the
   change to accept or refuse. They stand in for the one notice that says proposals wait, which the list leaves out,
   and the inbox's count adds them (`useInboxWaiting`). The page of all proposals stays, in More.
5. **One entry in the sidebar.** The tool that was "Waiting on you" is the inbox: always in sight, its count what
   waits on the person, its name bold while something is unread. Approvals is no longer a tool (a saved place for it
   is ignored), and the bell is gone.
6. **The phone.** The Activity tab is the inbox: what waits is rows of the list, the filters are the bar's menu, and
   a request or a question opens on a pushed screen with the decision at its foot, where a request was a sheet and a
   question went to its conversation. A device's notice keeps its card, since it is decided on it.

## Consequences

- The approvals page's search and its list of missions waiting are gone with it; missions waiting stay in Threads.
- The phone's request screen has no "remind me later" or "done" of its own yet, and proposals on the phone stay on
  their own screen.
- A person who had moved the old tools keeps where they put "Waiting on you", which is now the inbox.

## Addendum 2026-11-24: the phone's request reads as the web's review

On 2026-11-04 the web's review of a request got a facts strip, "Como chegou aqui" and a line on what approving
lets the agent do, while the phone kept its sheet. With §6 the phone's request is a pushed screen, and it now carries
the same three pieces:

- **Facts strip** under the title (`FactStrip` in the phone's kit, `requestFacts` in `features/approvals/logic.ts`):
  Onde (the app, then the repository, channel or account), Efeito, and Quem decide when a role answers for it. The
  deadline stays the fuse's line above the title and how it ended stays the line at the screen's foot, so each fact
  is said once. The effect leaves the foot's list of traits.
- **Como chegou aqui** (`ApprovalTrail` in `features/chat/ToolCalls.tsx`): the run's steps before the ask, the ask, the
  decision and what ran after it, split by `stepsAround` as on the web, in the conversation's tool block, closed.
- **What approving lets the agent do**, over Recusar and Aprovar: the web's "Ana vai …, só desta vez e com estes
  valores" (or when an approval made ahead applies). With "Aprovar sempre" on, its row says it instead.

Where a request stands (`approvalPhase`, `PHASE_STATUS`) moved from the web's page to the client
(`lib/approval-card.ts`) so both apps read it the same way.
