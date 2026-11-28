# 0182. Approved actions run in the order the agent asked

- Status: Proposed
- Date: 2026-11-13
- Amends: ADR 0015 (a run resumed by its decisions may first wait for the requests asked before its own on their card)
- Amended: 2026-11-24 (below: a card holds one conversation, the order holds only behind what a run was told)

## Context

A person approving an agent's requests reported that they came, or were approved, out of order. One run already does
its own calls in the order the model made them, whatever order they were decided in: it resumes once all of them are
decided and runs the approved ones in turn (ADR 0015). Runs sharing a card did not. While a run waits on an approval it
takes no new messages (`run-hold.ts`), so a message sent meanwhile starts a run of its own, and that run's requests join
the same card (`openApprovalCard`). Each run resumed on its own decisions: approving the later request first ran its
action first, and "Approve all" over requests of two runs resumed both at once. A request refused after a later one
was approved left that later one to run anyway, though it may only have made sense after the first.

The Approvals page listed the requests by their deadline, closest first, not in the order asked; an action approved
ahead (whose deadline is its routine's time) came first. Its keys (J/K) and the request opened beside the list followed
that flat order while the list drew each card's requests together, so they jumped between cards. The phone listed
what waits on the person by deadline too.

## Decision

1. **A card is a line.** An agent's requests on one card (the same agent in the same conversation) keep the order they
   were asked in (`created_at`, then the time-ordered id). Actions approved ahead (`run_at`) and a mission's requests
   (no run) stand outside any line.
2. **Decide in any order, run in the order asked.** A run whose decisions are all in still waits while another run of
   the agent has a request on the same card, asked before the run's place, that isn't settled: waiting for a person, or
   approved without a result while that run goes on (`executed_at` is set when a run claims an action, before its tool
   returns, so only the result says it is done). `heldBehind` checks this where the executor takes a waiting run back.
   A run's place is its earliest approved action still to do, across its cards, so no two runs ever wait on each
   other: when requests interleave, the run asked first goes, with all of its actions.
3. **Waking.** A request settling wakes the agent's runs waiting behind it on its card (`wakeLine`), one job per run and
   request settled: refused, expired, canceled or replaced when decided; approved once its run has done it (or kept it
   from running); and every request of a run that fails or is stopped (`transitionRun`; one that ends done settled its
   own on resuming). The expiry worker also resumes, every minute, a run still waiting although nothing holds it any
   more: an approved action to do on a card shared with an earlier request of another run (decided within a week),
   nothing of its own left to wait for, nothing before it and no job on its way (`resumeHeldRuns`, the longest waiting
   first).
4. **Approved before an earlier request was refused: not run.** When its run gets to it, an approved action whose card
   has a request asked before it that was refused, or expired unanswered, after this one was approved does not run. Its
   result says so and names that request (`result.notRunAfter`); the agent reads why and may ask again. One approved
   after the refusal was approved knowing it, and runs. This holds inside one run as well.
5. **The agent's other runs.** A run started while another waits reads what is already asked in the conversation
   (`heldHere`): the requests waiting for a person, and now those approved and waiting their turn, so it neither asks
   for them again nor does them itself.
6. **The apps.** The Approvals page and the phone list requests in the order asked, each card's together at its first.
   A request on a card with others says its place ("2 of 3"). An approved action waiting its turn reads as in line
   ("Approved. Runs after …"), one kept from running as not run; the conversation's card says the same after the
   decision. J/K and the request opened beside the list follow the order drawn, and deciding the open request opens the
   next one waiting on that person. The header's warning still names the request closest to its deadline. The apps
   work the line out from the card's requests by the same rules (`approvalLine`), so it changes as each request does.

## Consequences

- Order no longer depends on which request a person happens to decide first, and an action never runs ahead of one
  asked before it that a person refused.
- A request left undecided holds the agent's later actions on that card until it is decided or expires (24 h). The card
  shows what each waits for.
- A run holding an approved action behind another stays `waiting_approval`; its resume is one more query.
- Two runs whose requests interleave on one card keep only the order between runs: the first one's actions all go
  before the second's.
- Not covered: order between cards (another conversation, another agent), and an action approved ahead.

## Addendum of 2026-11-24: the order only where it is real

### Context

A card held more than one conversation. `openApprovalCard` joined any pending card of the agent in the channel's main
timeline, whatever message started its run, so in a channel where every customer writes a top-level message, every
request of the day landed on one card, and point 1 made that card a line: an approved action for one customer waited
for an unrelated request asked hours earlier for another, until a person refused that one or it expired (24 h). The
card said only "Runs after …", with nothing to do about it. Changing the agent to "Nunca perguntar" left the waiting
requests in place.

The guarantee point 1 was written for still stands: a message sent while the agent waits starts a run of its own, and
its actions should not overtake the ones asked before it that its run was told about (`heldHere`, point 5).

### Decision

1. **A card holds one conversation.** A request joins an open card only of the same conversation (`thread_root_id`)
   or of the same run. Two top-level messages are two conversations, even in one channel's main timeline.
2. **A run waits only for what it was told.** When a run posts its requests, each records the other runs' requests
   `heldHere` told it were already waiting in its conversation when it started (`approvals.after_ids`). An approved
   action waits only for those (`blockersOf`), and is kept from running (point 4) only by those or by its own run's.
   Since `after_ids` names only requests asked before its run started, two runs still never wait on each other.
   Waking (`wakeLine`, `wakeLineOfRun`) and the safety net (`resumeHeldRuns`) follow `after_ids`.
3. **Stale requests hold nothing.** A request waiting for a person for more than 30 minutes (`STALE_HOLD_MS`) holds no
   other run's action. The safety net resumes a run once what held it went stale.
4. **"Rodar este agora".** Whoever may decide an approved action waiting for others may run it at once
   (`POST /organizations/{orgId}/approvals/{id}/run-now`): its run's approved actions still to do forget `after_ids`,
   the run resumes, and the audit records `approval.run_now` with what it no longer waited for.
5. **A level that no longer asks frees what waits.** When an agent is set to "Nunca perguntar" (on its own or by the
   workspace's level), or a connector's tool moves off "Pede sua aprovação" while its agent asks only for what is
   risky, the requests still waiting that would no longer ask are canceled, never approved on the person's behalf:
   their runs read that nobody needs to approve them any more and call them again, now without a card
   (`releaseUnasked`).
6. **The apps.** An approved action that waits says what for, by name, linking to that request, with "Aprovar" and
   "Recusar" for it where the person may decide it and "Rodar este agora" where it is another run's ("Esperando …").
   The inbox and the phone's list of what waits decide every request of one agent at once ("Aprovar todos",
   "Recusar todos"), through the same endpoint as a card's "Aprovar tudo". The apps work the line out from
   `afterIds` over the requests they hold (`approvalLine`).

### Consequences

- Requests never share a card across conversations, and a run waits only for what `heldHere` told it. In a channel's
  main timeline every run answering there is told about the others (a new message there is a follow-up, ADR 0029), so
  two top-level messages still wait for each other's earlier requests, for at most 30 minutes of nobody deciding, with
  "Rodar este agora" to skip it. A thread never waits for another thread.
- Point 1's "a card is a line" now means a run's own requests in the order asked, plus what each was told. A card of
  one conversation is that, nearly always.
- Changing a level cancels requests, which the agent redoes. A request the new level would still ask for stays.
- Not covered: an agent moved from "Sempre perguntar" to "Só o arriscado" (whether each waiting call still asks would
  take the tool's own definition): those requests wait for a person as before.
