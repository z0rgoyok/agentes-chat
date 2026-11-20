# 0191. Outside collaborators: people a workspace lets in who take no seat

- Status: Accepted
- Date: 2026-11-16
- Extends: ADR 0068 (requests to join), ADR 0079 §4 (the `members` limit), ADR 0056 (the operator API and its events
  feed)
- Code: schema `packages/db/src/schema/tenancy.ts` (`organization_members.outside_of`,
  `organization_join_requests.outside_of`, migration 0286); engine `packages/engine/src/invite-requests.ts`
  (`requestOutsideAccess`, `endOutsideAccess`, `listOutsideAccess`, `approveJoinRequest`, `denyJoinRequest`),
  `organizations.ts` (`joinOrganization`, `removeOutsideMember`, `changeMemberRole`, `listMembers`), `limits.ts`
  (`memberCount`), `operator.ts` (`memberCount`), `operator-events.ts`; routes
  `apps/server/src/operator/outside-access.ts`; client `packages/client/src/api/types.ts`; tests
  `packages/engine/test/join-requests.test.ts`, `limits.test.ts`, `operator-events.test.ts`,
  `apps/server/test/operator.test.ts`, `operator-canary.test.ts`

## Context

A workspace sometimes works with someone who is not part of it: a consultant, or whoever sets its agents up for it.
To do the work they have to be in the workspace like anyone else. On a server whose operator limits how many people a
workspace takes (ADR 0079 §4: the `members` limit, which a billing service sets), letting them in used one of the
workspace's seats, although the workspace never hired a seat for them and they leave when the job is done. A full
workspace could not let them in at all. A self-hosted server sets no limit, so it never had the problem.

## Decision

1. **An outside collaborator is a member whose row says who they work for.** `organization_members.outside_of` holds
   that text (1 to 80 characters after trimming), shown beside their name; null for everyone else. In every other
   respect they are a member: roles, channels, agents, and what they see.
2. **They don't count.** The two counts that feed limits and billing leave out rows with `outside_of`: the one behind
   `assertMemberRoom` and the app's `GET …/limits` (`limits.ts`), and the operator's (`GET /orgs`, `counts.members` of
   `GET /orgs/{orgId}`, and `usage.members` of the billing link). The workspace did not hire a seat for them, and the
   operator, who is asked for each one, vouches for who they are. What counts who is present still counts them: the
   people in the sidebar (`orgOverview`) and the usage report.
3. **Only the operator API asks.** `POST /orgs/{orgId}/outside-access` with `{ userId, outsideOf, note? }` files the
   request; nothing in the workspace's own API marks anyone as outside. Otherwise a workspace could call its whole
   team outside and never reach its limit. A self-hosted server has no limit, so it loses nothing by having no other
   way to ask.
4. **The workspace answers, like any request to join** (ADR 0068). The request is a row of
   `organization_join_requests` with `outside_of`, the account in `user_id`, no link, and `verified_at` set: the
   operator named the account, so nothing is left for its address to prove. Whoever may invite people is told the way
   they are told of someone asking through a link (the merged notice, its push, the hour's email) and approves, with
   the roles, channels and agents they choose, or denies. An approval lets that account in at once, into a full
   workspace too, and never sends an email invitation. The request closes unanswered after 14 days, as any does; the
   daily sweep of requests to join (`pruneJoinRequests`) then marks it `closed`, so the operator is told once.
   Asking again while it waits changes nothing and answers the same request; an account already in the workspace is
   refused (`join.member`), and so is one whose address has another request waiting (`join.waiting`), which is
   answered first. At most 50 outside requests wait in a workspace (`join.full`), counted apart from the 50 asks
   through its links, so the operator's requests never use those up. An account blocked or waiting for its deletion is refused (`outside_access.account_closed`), as
   every other way into a workspace refuses it; one that becomes so while its request waits has the request closed
   when someone approves it, and the approval answers that same code. While it waits, an ask through an invitation
   link for its address never takes it over: that ask is answered as one for an address someone already asked for
   (`join.waiting`), and the request keeps the account the operator named.
5. **Leaving.** Whoever may remove members removes an outside collaborator like anyone, and they may leave. The
   operator ends it with `DELETE /orgs/{orgId}/outside-access/{userId}`: a request still waiting closes, and a member
   is taken out with everything a removal does, the audit log's entry being the system's. It refuses an ordinary member
   (`outside_access.member`) before it changes anything, a request still waiting for them included: only the workspace
   removes one of its own.
6. **Never an owner.** Making an outside collaborator an owner is refused (`member.outside_owner`): they answer to
   whoever they work for, not to the workspace. So a sole owner whose only other people are outside collaborators,
   refused their account's deletion (`sole_owner`), is told that the way out is to invite a member and make them an
   owner, or to delete the workspace: the plan marks such a workspace `onlyOutside`, and the refusal carries
   `params.onlyOutside` when every workspace that keeps the account is one.
7. **What the operator reads.** `GET /orgs/{orgId}/outside-access` lists `{ userId, outsideOf, state, since }`,
   `state` being `pending` or `member`. The events feed (ADR 0056 §5) gets `outside_access.granted` when a request is
   approved, `outside_access.denied` when it is denied, and `outside_access.ended` when an outside collaborator leaves,
   is removed by anyone or deletes their account, and when their waiting request is over without an answer: closed
   through the `DELETE` above, closed at an approval because the account was blocked or is being deleted, run out
   (told by the daily sweep, so up to a day late) or gone with the account's deletion; each with `orgId` and
   `data: { userId }`, once per request.
8. **What the workspace reads.** `outsideOf` on a member (`GET …/members`, `GET …/people`) and on a request to join
   (`GET …/join-requests`), optional so that an app reading an older server still parses. In the audit log,
   `join_request.approved`, `member.removed` and `member.left` carry `outsideOf` in their details for these people.
9. **What they see is not narrowed here.** An outside collaborator sees what any member with their roles sees.
   Narrowing it belongs to the guest role ADR 0085 leaves for later (a base that replaces `everyone` and sees only
   where it is put): `outside_of` says who doesn't count, and that role will say what they see.

## Consequences

- A self-hosted server changes nothing: no limit is set there, and without `OPERATOR_API_TOKEN` nothing can ask.
- How many outside collaborators a workspace may have, and for whom, is the operator's own policy, kept in its own
  services: this server enforces none.
- `counts.members` and `usage.members` are now the people a plan counts, which may be fewer than the people in the
  workspace; the sidebar's count may read higher than the people meter.
- An outside collaborator who later joins another way (an email invitation accepted) has their waiting request closed
  like any other and is an ordinary member, counted. No event says so: the list above does.
- When the server takes someone out for its operator, what follows from the removal (their mailboxes leaving the
  agents, the approvals on them canceled, their agents' rules dropped) is recorded under the person who goes, as when
  an account is deleted; only the removal itself is the system's.
- The apps don't label these people yet: they read `outsideOf` and show them as members.

## Alternatives considered

- A switch in Members, for whoever manages people: the workspace would decide by itself who is free of its limit.
- A role or a permission: roles say what a person may do, never whether they count, and the base that narrows what a
  person sees is the guest role's.
- Raising the limit by one for each of them from the billing service: the limit would stop being the plan's seats,
  and the workspace could give the extra seat to anyone.
