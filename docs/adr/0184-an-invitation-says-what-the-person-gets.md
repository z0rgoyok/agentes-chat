# 0184. An invitation says what the person gets

- Status: Accepted (built: the server and the shared client. The web and the phone app come next)
- Date: 2026-11-14
- Revises: ADR 0090 §5 (one screen instead of steps: cargos, channels and agents for email invitations and links)
- Amends: ADR 0068 (a link carries choices, an expiry and a maximum, and a workspace has many. A link still only asks)
- Code: `packages/engine/src/invite-choices.ts` (`invitableChannelIds`, `stillInvitableChannelIds`,
  `invitableAgentIds`, `stillInvitableAgentIds`, `startWith`, `INVITE_LINK_TTLS`, `INVITE_LINK_MAX_USES`,
  `INVITE_LINK_NEVER`, `inviteLinkFull`), `packages/engine/src/organizations.ts` (`sendInvitation`, `createInvitation`,
  `inviteMany`, `updateInvitation`, `resendInvitation`, `inviteLink`, `previewInvitation`, `acceptInvitation`),
  `packages/engine/src/invite-requests.ts` (`createInviteLink`, `editInviteLink`, `listInviteLinks`, `askToJoin`,
  `approveJoinRequest`, `listWaitingJoinRequests`), `packages/engine/src/email.ts` (`queueInvitationEmail`,
  `emailCrew`) and `email/words/*` (`invitation.starts`, `invitation.more`), routes
  `apps/server/src/routes/app/invites.ts`, `management.ts`, `account.ts`, migration `0268_invite_choices`, the shared
  client (`packages/client/src/api`, `packages/client/src/lib/invite-start.ts`)

## Context

Inviting someone took four steps (who, role, where they start, a note) and gave one role per address, picked from
cards. Nothing tied an invitation to the agents the person would work with, and a link carried nothing at all: the
admin who approved a request picked a role then, and the person landed in #general with no channel and no agent. A
cargo (ADR 0085) already reaches channels (ADR 0125) and agents (its audience), so an invitation that names a cargo
can say what comes with it.

## Decision

1. **One screen.** The invite dialog has Para, Cargo, Canais and Agentes, for email invitations and for links alike,
   with no steps. Several cargos per invitation, one set for everyone in a send (`emails` with `roleIds`). `invites`,
   each address with its own roles, stays for older builds.
2. **Channels.** An invitation still adds public channels and private ones its sender is in, and now also a private
   channel limited to a cargo it gives (ADR 0125): whoever gets that cargo may see and join it anyway. Any other
   refuses it all with `invitation.channel`, naming the channel and why (`archived`, `left`, `gone`). On accepting,
   the person joins the ones whoever sent it could still give then, a cargo's own only with that cargo given.
3. **Agents** (`organization_invitations.agent_ids`, at most 20). An invitation may name an agent that talks to
   everyone, one limited to a cargo it gives, and a restricted one its sender may open (its owner, or who manages
   agents) when opening it takes nothing: it holds no mailbox someone else gave it, and it doesn't keep its plan for
   its owner (ADR 0059 §5). The right hand is everyone's, so it is left out quietly. Any other refuses it all with
   `invitation.agent`, naming the agent and why (`gone`, `locked`).
4. **Starting with them** (`startWith`). On accepting, each agent the person can't talk to yet, and that whoever sent
   the invitation may still open the same way, takes them into its audience, as "Deixar … falar" does: audited
   `agent.audience_changed` with `via: "invitation"`, its plan's owner told as for any change. One given someone
   else's mailbox since stays shut: a mailbox is never taken unasked, days later. Then the agents they can talk to
   become their sidebar's pinned agents (`sidebar_items.view.pins.agents`, at most 5), only while they have no view
   of their own. Someone already in starts with none, as they get no roles (ADR 0085).
5. **Changing an invitation.** `PATCH …/invitations/{id}` takes `roleIds`, `channelIds` and `agentIds`, each checked
   as when sending it, the ones left out kept, audited `invitation.changed`. Sending it again carries its channels and
   agents as far as the sender may give them then.
6. **Links carry choices** (amends ADR 0068 §9). `organization_invite_links` gets `role_ids`, `channel_ids`,
   `agent_ids`, `max_uses` (null: no limit) and `plain`. A workspace has many links. Its own link is the `plain` one,
   made with no choices: `POST …/invite-links` with none returns it as before, so older apps keep working, and at the
   defaults (no cargo, channel or agent, no limit, 30 days) it renews it to 30 days, so the dialog's "Vale até"
   agrees. Any other choice makes a link of its own, checked for its maker as an invitation's (`invite_link.choice`
   for a value off the lists). "Validade" is 30 minutes, an hour, 1, 7 or 30 days, or never (an `expires_at` of
   9999-12-31, so every `expires_at > now` check holds). "Máximo de pessoas" is 1, 5, 10, 25, 50, 100 or none.
   `PATCH …/invite-links/{id}` changes one at the same address, which is then a link of its own. Audited
   `invite_link.created` and `invite_link.changed`. Whoever opens any link still only asks (ADR 0068 §1).
7. **A full link.** Once the approvals through a link reach its maximum, asking through it (its code steps included)
   answers `join.link_full` for every address alike, and its preview says `full` before anyone asks. Approving
   through it is refused too (409 `join.link_full_approval`, with the approver's way out: a bigger maximum). A
   request filed before it filled waits until it is turned down or the link's maximum grows, and the waiting list
   marks its link `full`. Approvals in a workspace take turns, under the lock asks are filed under, so two at once
   never pass the maximum. An expired link's maximum can still grow (its own change stays allowed while it is turned
   on), so the requests that wait on a full, expired link can be approved; the link stays expired.
8. **Approving.** The approver gives the cargos they pick (the apps start on the link's), and the link's channels and
   agents as far as the approver may give them at that moment, the rest left out, so approving stays one click. The
   approval may carry `channelIds` and `agentIds` instead, checked as an invitation's. Joined at once, the person
   joins those channels and starts with those agents. Invited, the invitation carries them. Each waiting request says
   the link it came through, who made it and what it gives.
9. **What the person sees.** The invite page's preview gives the cargos (`roles`: name, color and icon, those the
   sender may still give) and puts the invitation's agents first (`yours`: how many lead the list, the first is the
   host). The email says the cargos ("como Suporte", while an owner's stays "como dono") and, when there is more than
   #general and the right hand, one line: "Você já entra em #suporte e #chamados-urgentes. Vai trabalhar com Max.",
   in every language. A list stops at five places, the last saying how many more ("e mais 3"), and a channel's name
   is held whole. Its picture puts the invitation's agents first.

## Consequences

- Migration 0268 adds six columns, all with defaults: invitations and links made before read as they were, the links
  as plain ask links.
- Older apps keep working: a link made with `{}`, a batch without agents, a change with `roleIds` only, an approval
  with roles only.
- A cargo an invitation gives that opens an agent still takes that agent's mailboxes others gave it, on accepting
  (`dropMailForNewRoleMember`): the agent field refuses such agents, the cargo doesn't ask yet.
- Someone who changes an invitation another person sent is checked for what they add, and accepting checks again for
  whoever sent it, as roles already were (ADR 0090).
- The approver, not the link's maker, gives a link's channels and agents: a private channel only the maker is in
  doesn't go with an approval by someone else.

## Alternatives considered

- A link whose people get in at once ("Entra direto"): left for later. ADR 0068 holds: every link asks.
- Getting a cargo puts the person in its channels at once, as Discord does: that changes ADR 0125. An invitation
  ticks the cargo's channels instead, and people who get the cargo later join when they want.
- Agents as access only, with no pin: every agent talks to everyone by default, so the field would do nothing.
- Telling the workspace's own link apart by its choices alone: a 7-day link with nothing else would then be picked up
  as the workspace's and renewed to 30 days. `plain` says which one it is.
