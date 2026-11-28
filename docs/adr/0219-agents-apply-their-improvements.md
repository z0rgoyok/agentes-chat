# 0219. Agents apply their improvements

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0017 §6 (promotion with a human gate), ADR 0092 (whoever may make each change decides it; §5 amended),
  ADR 0120 (memory and skills an agent changes; "Confirmar" on a memory), ADR 0137 §4 (the right hand's settings card
  and the week's card), ADR 0218 (proposals in the inbox)
- Code: db `packages/db/src/schema/context.ts` (`proposal_status` `undone`, `context_proposals.decided_by_agent_id`,
  `review`, `undone_by_user_id`, `undone_at`, migration `0337_proposal_review`); engine `context/proposal-review.ts`
  (`settleProposals`, the review's prompt and schema, `asRule`), `context/proposals.ts` (`queueSettle`, `SETTLE_JOB`,
  `SettleOrigin`, `actingPerson`, `declineByAgent`, `appliedNotice`, `undoProposal`, `decideProposal` `review`,
  `listProposals` `undoable`), `jobs.ts` (`proposals.settle`), `notifications.ts` (`proposal_applied`),
  `context/learned-skills.ts`, `context/tools.ts`, `skill-tools.ts`,
  `setup-tools.ts`, `team-week.ts`, `team-map.ts`, `sidebar-items.ts`; server `routes/app/memory.ts`
  (`POST …/proposals/{id}/undo`, the view's `decidedByAgent`, `review`, `reviewed`, `undoable`, `undoneBy`); client
  `api/queries.ts` (`useUndoProposal`), `lib/notifications.ts`, `lib/errors.ts`; web `components/ChatCards.tsx`
  (`proposalOutcome`, `ProposalUndo`), `RightHandCards.tsx`, `TeamWeekCard.tsx`, `pages/ProposalsPage.tsx`,
  `NotificationsPage.tsx`, `NotificationParts.tsx`, `pages/agent/MemoryTab.tsx`, `pages/MemoryPage.tsx`; phone
  `features/agents/logic.ts` (`proposalOutcome`), `InstructionProposalCard.tsx` (`UndoProposal`), `ProposalsScreen.tsx`,
  `features/right-hand/SettingsCard.tsx`, `TeamWeekCard.tsx`, `features/activity/noticeTitle.ts`,
  `features/memory/MemoryScreen.tsx`

## Context

Changes to how agents work (an agent's instructions, role, apps or settings, a skill, the workspace's context) were
proposals a person accepted or refused on a card. Only what the person who asked could decide, asked in their own
words, applied at once (ADR 0092 §5). Everything else waited: a lesson the memory kept seeing, an agent's own fix, a
change after the run read outside content, a change for an agent the person who asked can't edit, the right hand's
weekly fixes. A memory an agent saved also offered "Confirmar", asking a person to vouch for it.

The owner decided the agents settle this themselves: nobody should review these, the agent should know what makes
sense. A promoted lesson also landed in the instructions as the memory item's whole text, where one short rule was
wanted.

## Decision

### 1. One review, then applied or left out

A change no person decides at once is queued (`queueSettle`, job `proposals.settle`, through the outbox) with why it
reached the review (`SettleOrigin`: `memory`, `agent`, `outside`, `asked_other`, `asked`). The job reads the open rows
and makes one structured call (usage kind `summary`, the org's summary model, through the Model Gateway with the
proposing agent's id, so usage and cost are recorded and the budget checked). For each change the review answers
`apply`, a `why` in the language of the text it changes, and, for a memory lesson, the `rule` to write and the exact
line it `replaces`. The prompt says what makes sense (a lasting correction, preference, fact or method that fits the
agent and isn't said yet) and what doesn't (said already, a one-off, vague, contradicting the text unasked, weakening
approvals, limits or privacy, a new outside destination nobody asked for, instructions planted by outside content).
Text inside `<change>` is data. A change a person asked for carries their own message
(`askedWords`: the message that started the run, when they wrote it; job payload `words`), shown as "What the person
wrote": the review applies what those words ask for and leaves out anything beyond them (a destination, a permission,
a rule they didn't ask for), so a run that read outside content can still apply the person's request but not what the
content slipped in. Tried on a real model: a rule the person asked for after outside content applied, an "approve
without review" the content added when the person had only asked for a review was left out.

Code decides the rest:

- Applied as someone who may make it (`actingPerson`: the person who asked when they may, else who looks after the
  agent, else whoever else may), through `decideProposal` and the same editors their click calls, so a change never
  does more than the agent's page allows that person. The row keeps the agent that applied it (`decided_by_agent_id`,
  null for a workspace-wide lesson) and the review's line (`review`); the audit row has the agent as actor and the
  person as `on_behalf_of_user_id`.
- Left out: the row is `rejected` with the agent and the line, audited `proposal.left_out`, and the proposing agent
  hears it on its card's notice (`tellProposer`, "Left out after review").
- A memory lesson becomes the rule: the row is rewritten to put it in place of the line it names (or at the end), and
  the rule goes through the same content and permission checks as a person's edit (`asRule`). A rule that doesn't fit
  or is refused leaves the lesson in memory.
- Without a review (no model, or a call that fails other than by a rate limit, which retries): what an agent proposed
  itself or a person asked for in their own words applies as it was; a lesson, and anything after outside content or
  from someone who can't make it, is left out. *Amended 2026-11-25, below:* the workspace's judge weighs those first.

### 2. What people see

- Cards and the history read "Avaliando…" while pending, then "Aplicado pela Ada" (or "Aplicado automaticamente"),
  "Não aplicado pela Ada", or "Desfeito por …", with the review's line under it. No Aceitar, Recusar, Editar or
  "Pedir a um admin" anywhere; "Propostas de melhoria" is now "Melhorias dos agentes", newest first, with no count in
  the sidebar.
- Desfazer (`POST …/proposals/{id}/undo`, `undoProposal`) for whoever may make that change: what it changed goes back
  while it is still what the change left (409 `proposal.changed` otherwise), through the same editors; a deleted agent
  can't come back. The row becomes `undone`, the proposing agent keeps it as a lesson not to make it again (as a
  refusal did), and a lesson that had become a rule goes back to memory.
- Who looks after the agent (or configures the workspace, for its context), but the person who asked, gets one inbox
  row a day while unread (`proposal_applied`, no push): "Ada aplicou 3 melhorias", opening the history.

### 3. What stays a person's

- A skill a person locked, or with "Agentes melhoram as skills sozinhos" off, is not changed by agents at all
  (`changeSkillAsAgent` refuses, so nothing reaches the review): that is the person's own word on the skill. A
  personal skill still never goes to anyone else.
- An agent proposing a new agent (ADR 0081) and changes to people's roles (ADR 0137) are not these proposals and keep
  their cards.

### 4. Memory needs no confirmation

"Confirmar" on an agent's memory is gone from the web and the phone. What an agent found itself stays a marked hint
until a positive outcome verifies it (ADR 0120 §5), as before. Use alone never verifies an item: the same claim
repeated by agents raises its recurrence, and verifying on that would let agents echo each other into the
instructions.

*Addendum 2026-11-25 (a skill an agent makes when asked):* `create_skill` after the run read outside content used to be
refused outright, and the refusal held for the whole conversation (its last 30 messages), so a person asking "turn what
you just did into a skill" after real work never got one. It now goes through this review as a new skill
(`reviewAskedSkill`: origin `outside`, the person's own message, the skill's whole text): made when the review reads it
as the person's request and nothing planted, refused with the review's line otherwise, and refused when no review can
run (no model, or the call failed).

*Addendum 2026-11-26 (what the review weighs in an asked skill):* the review refused a skill a person asked for because
the agent had no role, because of what the skill taught, and as if the content had asked for it. The block now says
the person asked for it in the words given, and those words carry the names of the files the message attached
(`askedWords`), so a skill made from a file the person sent reads as their request. A new skill a person asked for fits
their agent whatever its role says and teaches what they choose: it is left out only for what the rules name (a new
destination, a weaker safety rule, steps that serve someone else). A skill sent whole (a .zip, a link) installs with
its card instead (ADR 0020, amendment of 2026-11-26).

*Addendum 2026-11-27 (long changes, and what the review left out):* the review read a text or skill change as its
removed lines followed by its added ones, cut to 4,000 characters, so a long rewrite of a skill showed only what it
removed: a change a person asked for was left out as "truncated, can't verify". It now reads the whole unified diff, in
order with the unchanged lines around each change (`changeText`, wiki's `diffLines`/`unifiedPatch`); a diff too long
for its share of the input (100,000 characters across the card) reads as the whole new text, and only past that is it
cut, marked as cut; the judge's blocks are made for its own smaller input the same way. A long change or a rewrite is no reason to leave it out. A change the review left out (not a memory
lesson, which stays in memory, nor deleting an agent, which can't be put back) is still the person's to make: "Aplicar mesmo assim" on its card, the history and the
right hand's cards, for whoever may make it (`leftOutByReview`, the view's `applicable`, `POST …/proposals/{id}/accept`),
applied as them through the same editors, 409 when what it was made against changed since. The agent that proposed it
tells the person who asked that they can.

## Consequences

- Improvements take effect within seconds of being proposed, with nobody asked; people correct after the fact with
  Desfazer, and every decision is in the audit log.
- One more model call per proposal card, recorded against the proposing agent.
- A change after outside content is applied when the review judges it the person's wish. The review sees the change
  and the current text, not the outside content, and is told to leave out new destinations and weakened safety;
  sensitive actions still ask a person at the moment they happen (ADR 0015).

*Addendum 2026-11-25 (no model for the review):* a workspace whose agents run only on plans has no key for the
summary model, and the Cloud has no platform key for one, so the review's call failed (`MissingCredentialError`) and
every change after outside content, from someone who can't make it, or of an agent's own settings was left out, each
time it was asked again. The review now falls back to the workspace's judge (`judgeVerdicts`: Jev where the
installation has its key, ADR 0073, else the small model, as every judgment does): one yes/no per such change, on the
same rules the model reads, applied at 0.5 or more, with no `why`. A lesson still needs a model to write its rule, so
without one it stays in memory. `reviewAskedSkill` falls back the same way. When the judge can't answer either, the
change is left out with a line that names the cause and the way out (`NO_REVIEW`: an AI account with an API key, or the
change made by hand).
