# 0190. Confidential results: a listed server's answer seals the thread that read it

- Status: Accepted
- Date: 2026-11-16
- Code: engine `packages/engine/src/confidential.ts` (`markThreadConfidential`, `sealStragglers`, `unsealed`,
  `runConfidentiality`, `thinksAsThread`, `isConfidentialRun`), `confidential-prune.ts` (`pruneConfidential`),
  `tools/confidential-lock.ts` (`confidentialLockAllows`, `asksOutside`), `tools/gateway.ts` (`markedStep`, the lock
  in `invoke` and `runApproved`), `connectors/mcp.ts` (a result's `_meta`, `ToolDefinition.server`), `messages.ts`
  (the `sealed` part of `insertMessageWithRuns`, `forRunId`, `messageView`), `run-resume.ts` (`deliverNoticeToRun`),
  `context.ts` (`buildRunContext`'s `unseal`), `live-steer.ts` (`renderSteered`), `executor.ts` (`followThread`,
  `CONFIDENTIAL_AI_CHANGED`), `routine-ledger.ts` (`closeRoutineRun`), `judge.ts` (`refuseConfidential`), `format.ts`
  (`inertLinks`, `inertJson`), `apps/tools.ts` (`stubOf` for a person's connected AI app), `operator-review.ts`
  (`runReview`, `taskReview`, `taskRunSql`), `operator-runs.ts` (`runOf`), `operator-jobs.ts` (`jobOf`),
  `operator-reveal.ts` (`findStep`, `findTask`, `findMessage`); schema `packages/db/src/schema/chat.ts`
  (`confidential_threads`, migrations 0286 and 0287); server `apps/server/src/workers.ts` (`confidentialPrune`); tests
  `packages/engine/test/confidential-results.test.ts`, `confidential-lock.test.ts`, `confidential-copies.test.ts`,
  `confidential-prune.test.ts`

## Context

A workspace connects an MCP server by address (ADR 0016), and whoever runs an instance can list the hosts of their
own servers (`MCP_CALLER_IDENTITY`, ADR 0181). Some of what such a server answers is somebody's private text: a
secret from a vault, a person's record from an internal system. An agent that reads it needs to go on working, and
the text must not travel: every published account of prompt injection says the same, that an agent which reads text
it does not control can be steered, that nothing detects it reliably, and that the control is what the agent can do
afterwards.

Text from outside already has a mark (ADR 0117): a connector's result is `external`, its step carries
`outside: true`, and what the run posts next carries `meta.readOutside`, so memory built from it stays low trust.
That mark lowers trust. It does not stop the text from being posted elsewhere, searched, summarized, quoted in a
notification or kept for good.

## Decision

A server the operator vouches for can mark a tool result as confidential. A run that read one goes on reading,
answers in a thread under the message that asked it, and sends nothing elsewhere. Outside that thread no model is
given its text, and what the product kept of it is removed 60 days later. Nothing here is on until a listed server
marks a result: an install with no such result stores, posts and runs as before.

### 1. The mark

`callTool` passes a result's `_meta` on. A result whose `_meta["chat.agentes/confidential"]` is `true`, from a
server by address whose host is in `MCP_CALLER_IDENTITY` (over https, on its own port, never through a connections
broker), comes back from the connector source with `confidential: true`, and the Tool Gateway writes
`data.confidential: true` on its step, beside `outside`. From any other server the key changes nothing: a connected
server must not be able to lock a run.

### 2. The thread, and the seal

The step and its thread's mark are written in one transaction (`markedStep`): a row in `confidential_threads`, keyed
by the root message of the run's thread, with the connections whose results marked it and what thought for the run
that read the first one (`thinks_with`, as `model:<provider>`). The mark follows the thread alone. It never looks at the channel's newest messages, as `runReadOutside` does: one finding would then lock every
later run of the channel. A run is confidential when its thread is, and a run does not leave such a thread: it is not
moved to the background, and the tool that moves a run elsewhere is refused.

One move is left as it is. A run another agent asked becomes handed work by itself (`handOverWork`), in a
confidential thread as in any other, and handed work shows where the person behind that agent asked. No words leave
by it: the work's title is the asking agent's own note, the run's updates and its questions are refused by the lock
(section 5), the copy of its report posted there is the stub, and the prune takes that copy with the thread
(section 8).

Every message of a confidential thread is **sealed**, the root included, since the root may hold what a person pasted
before any mark existed: `messages.body` holds a stub (`[confidential: readable only in its own thread]`), the words
live in `meta.sealedBody`, and `meta.confidential` is true. The statement that writes a message seals it when its
thread is confidential, when a run of such a thread writes it, or when the server writes it for such a run
(`forRunId`: a notice the run will read, the line of a follow-up it set); that is the same single statement as
before, with no query added. So whatever reads a message's body gets the stub without knowing any of this: another
run's context, the router, a search, a summary, a notification, a quote, the answer handed back to an agent that
asked. Two readers get the words back (`unsealed`): the people who read the conversation (`messageView`), and a run
of that same thread that thinks through the Model Gateway (`buildRunContext` with `unseal`, and the messages it is
handed mid-run, `renderSteered`).

Who reads is decided by the thread's row, never by a message's mark alone. A run of a confidential thread can leave a
marked message outside it (the copy of a handed work's report where the person asked): a run asked under that message
is not locked, so it is handed the stub like any other.

A person's connected AI app (ADR 0119) is no such reader. Its tools act as the person, but what they answer is read
by the app's model, which is outside every thread: `read_conversation` and the reply that `send_to_agent` and
`wait_for_reply` carry hand a confidential message out as the stub, with no file's name, and leave out the error of
a failed run of such a thread (`stubOf`).

**One provider reads a thread.** The words stay with what first read them. A run that thinks through another
provider than the row's `thinks_with` (another agent named in the thread, the same agent after its model changed)
ends before its first model call with a line that says so (`CONFIDENTIAL_AI_CHANGED`), is handed the stub for the
thread's messages mid-run, and the stub for a confidential result. A server that looked at the `provider` claim
before answering (section 9) is therefore not undone by a mention.

A message written while the mark was being committed, and a note the server rewords in place, are sealed by the
daily job (`sealStragglers`).

### 3. Where a confidential run posts

Under the message that asked it. A run asked in the main timeline answers there (`replyThreadOf`), so its finding
would sit among the channel's messages with no thread around it. It is decided in the statement that writes the
message: a message that names no thread, written by a run of a confidential thread or for one, goes under that
thread's root. One place covers the reply, a card, a question, a block, a note, and what the server writes for the
run: a follow-up's line and its wake, a poll's result, a wait's late answer. A notice that would be delivered where
a routine reports, or where a long work reported, stays in the run's own thread instead (`deliverNoticeToRun`), and
the run it wakes is a run of that thread, locked like the first. What the run posted before its first
confidential result stays where it is: it holds none of the words. Web addresses in a message such a run writes are
stored inert (`inertLinks`: a link keeps its words and an address loses its scheme), so no app renders a link whose
address could carry words out on a click. That holds whatever an app takes for code: the web and the phone pair
backticks and fences differently, so the stored text has no `](` and nothing right after a `://` anywhere, code
included. The same is done to what such a run types on a card, which the apps show as formatted text too: a
question, a choice card, a poll, and an approval's title, detail and reason (the Tool Gateway, `inertJson`).

### 4. The stub, outside the thread

Outside its own thread a confidential message reaches no model, whatever thinks for the run. The stub stands in its
place and does not mark the run that reads it: in the rest of the channel that every run's context is built from, in
a `search_context` hit, in a message read by its link, in an open question listed for the agent in another thread,
in what a person's connected AI app is answered, and in the lines about what other runs did
(`(confidential, not shown)`). The operator API's review of a run (ADR 0056) says the same of each call of a run of
a confidential thread: which tool, how it ended, and nothing that went in or came back. Its review of a task such a
run started gives the task's facts and says the same of each text the task holds. Its reveal door (ADR 0056's
addendum) refuses such a run's steps and such a task under either purpose (403 `reveal.confidential`). A task the
server started again by itself has no run of its own: for the review and for the door it is its first task's run's,
through any number of restarts. The review blocks and the door read a message of the thread as the stub whatever
its stored body, so one written while the mark was being committed says nothing before it is sealed. The API's list
of runs, and every other answer that holds a run, says such a run's error by its code, with none of its words
(`runOf`), and a job of such a run says no last error (`jobOf`). So a run asked by another message of the same
channel is neither given the words nor locked by them.

### 5. The lock

One check in the Tool Gateway's `invoke`, after the run's policy and before anything asks a person, and again when
an approved action runs. **By name, not by kind**: a kind is wider than its name (`here` holds a GIF search and
cards that make things, `self` holds the status line every member sees). In a run of a confidential thread a tool
runs only when it is on this list:

- every tool of a connection that marked the thread;
- a built-in read: `computer_status`, `expand`, `find_agent`, `get_my_usage`, `get_summary`, `list_artifacts`,
  `list_files`, `list_issues`, `list_reminders`, `list_routines`, `load_skill`, `read_artifact`,
  `read_conversation`, `read_file`, `read_skill_file`, `read_wiki_page`, `search_context` and any other built-in
  tool the run policy sorts as a read. Not `web_search`, `web_fetch` or `search_wiki`: their words leave the server
  (the wiki's search embeds its query). `search_context` searches by words only, with no call to an embeddings
  provider, and shows the stub for a sealed message; from any thread it leaves out the steps of a run of a
  confidential one. `phone_screenshot` and `phone_logs` are reads too, and are said in the tool's own words: a
  label the run gives would be read by the phone's owner in their notification, kept by the computer the phone is
  plugged into and shown with the phone's status;
- a connected app's read, only on a catalog connector or on a server the operator listed. A custom server by
  address, a tool reached through a connections broker, a mailbox and a workspace's database are refused: a read's
  arguments go to whoever runs the server. A read an admin marked to ask is no read;
- in the run's own conversation: `react`, `send_sticker`, `ask_user`, `ask_choices`, `show_block`, `start_poll`,
  `follow_up`, `cancel_follow_up`, `release_waiting_agent`. `show_block` replaces only a block shown in that thread:
  one shown anywhere else is read and indexed outside it. `release_waiting_agent` carries no reason: it would be
  written in a step of the other agent's run, which may belong to another thread. What a run asks a person is not
  always posted where it answers (`asksOutside`): a routine's own run asks where the routine reports, and a run
  another agent asked asks where the person behind that agent is. When that is outside the thread, its question and
  any tool that would ask for an approval are refused: other people read the card, and a reply under it starts a run
  the lock does not hold;
- on the run or its agent alone: `withdraw_request`, `set_reply_style`, `wait_for_device`, `commit_co_author`.
  `withdraw_request` takes back only a request of that same thread, and carries no reason: the reason is read by the
  run that waits and by the people at the card. `wait_for_device` asks a device's owner with none of its note: the
  owner may not be in the conversation, and the request and its notification are not the prune's to take. The card
  in the thread keeps the note;
- `pass`; `find_tools`, `use_tool` and `run_approved_action`, with the lock judging the tool they reach.

Everything else is refused, a tool added later included, with the code `confidential.outbound`. It is among the
codes the turn's judge reads as final (`SAFETY_CODES`), so nothing nudges the agent to find another way. It is a
refusal and never an approval card: an agent set to never ask would have the card lifted.

Six tools were weighed for the list and left off it, since none is needed to read, ask or answer: `update_thread`
(a thread's title is read outside the thread), `share_artifact` (it gives a file to people outside the
conversation), `offer_answers` (a card that makes something that outlives the run), `browser_ask_person` and
`desktop_ask_person` (the browser and the desktop are refused, so there is nothing to hand over), and `hand_off` (a
routine's report is kept as the routine's record, which its next run is handed outside the thread).

The audit log keeps which tool a run of a confidential thread called and how it ended, never its arguments, title
or reason: that log is kept for good.

### 6. A program on a computer cannot be locked

Its own shell and web fetch never pass the gateway. So a run that does not think through the Model Gateway never
gets confidential text, in its own thread either: the stub stands in for the tool's result (and nothing is marked),
for a search hit, and for the thread's messages in its context and mid-run. A run that read the thread and comes
back to another provider's model, or to a program on a computer, ends there with a line that says so
(`CONFIDENTIAL_AI_CHANGED`): its transcript holds the words.

### 7. No other model reads it, and nothing copies it

- **Learning.** No learning job is queued for a run of a confidential thread, a job queued before the mark does
  nothing, and a refused approval of such a thread leaves no lesson.
- **Summaries, reflection, the thread's name and assessment** skip a confidential thread whole (`loadThread`,
  `ensurePeriodSummary`, `nameConversation`, `assessThread`); a summary made before the mark is archived with it,
  and deleted by the prune.
- **The small judge.** No judge answers for a run of a confidential thread (`refuseConfidential`): it fails like a
  judge that is off, which every caller already does without. That covers the turn's end, a held reply, the stuck
  check, the context budget, the tool loader, the status line, a question's check, the automatic model and the
  reaction or GIF after a reply (which is also skipped by the reply's own mark). A judgment about a message reads
  its stored body, which is the stub: a stop said in words, a mention's need, an alert's triage.
- **Who is asked.** A message typed into a confidential thread that names several agents, or everyone, is not put
  to a judge: every agent named is asked.
- **The routing model** reads stored bodies, so the stub, and no quote a sealed message carries.
- **The conversation layer** that answers for a working run is not asked for a run of a confidential thread: its
  snapshot is made of the run's own steps.
- **The search index.** Its builders answer nothing for a sealed message, and nothing for a block or a poll shown in
  a confidential thread. When a thread is marked, the documents of its messages are deleted in that transaction.
- **Notifications.** A notification of a sealed message keeps no snippet, no quote and no preview, so the phone
  push and a mail that quotes it say only that there is something to open; snippets kept before the mark are
  blanked with it. A question's and an approval's notification keep no text.
- **A task.** A reply in a confidential thread is not copied onto the task it works on.
- **Team actions.** A call of a confidential thread is neither checked against what the team did nor recorded as a
  team action: both keep the call's targets and words for good, and the record is searched by every agent.
- **A routine.** A routine's own run that read a confidential result ends silent: its final text is neither kept as
  the routine's record (its next run is handed that) nor delivered as its report.
- **Long work.** What a work's run said between its calls is left out of what the agent's other runs in the
  conversation are told about that work, once its thread is confidential.
- **A mail about requests left waiting** counts one made in a confidential thread and quotes nothing of it.
- **The lines other readers get of a run's calls** show a confidential result as `(confidential, not shown)`
  (`runCalls`, so the judge's and the hand-off's lines), and the agent's recent work lists nothing a run of a
  confidential thread did.

Every reader of the outside mark was walked for this one: `apps/tools` (an app's post into such a thread is sealed
like any message), `cache` (the confidential runs have their own list, `sealedRuns`), `chat-tools` and
`consultations` (posting elsewhere and asking another agent are refused by the lock), `context` (the stub outside
the thread), `context/backfill` (skips a confidential message), `context/summaries` (skips the thread),
`context/tools` (the stub for a hit and a read by link), `delivery`, `git/github-events`, `hand-off`,
`machine-tasks` and `missions` (what they write into such a thread is sealed by the statement that writes it; their
tools are refused), `executor` (the reply's mark comes from that same statement), `outside` (unchanged: it reads no
confidential text) and `tools/types` (`ToolOutput.confidential`, set by the connector source alone).

### 8. The prune

A daily job (`confidentialPrune`), with `CONFIDENTIAL_KEEP_DAYS = 60` in code.

- **A thread** marked more than 60 days ago: every message of it, the root and a person's replies included, loses
  its text in every column that holds it and reads as removed (`meta.bodyCode` `confidential_removed`, worded by the
  apps). So does what a run of the thread reported outside it, found by the run's reply and its long work's result:
  a report that was posted where the work was asked, and the copy of a handed work's report. Files its messages carried, and the blocks and polls shown in it, become tombstones whose contents the
  purge of deleted files takes; a voice message loses its words and its recording; the thread's title goes, and
  the summaries made of the thread before its mark are deleted, every version. A message added later is blanked by
  the next pass.
- **A run** of such a thread that ended and is older than that loses the kept text of its steps (a step keeps its
  tool's name, how it ended and its code), its transcript, the words of its error after the code, its questions'
  text and answers, and its approvals' title, detail, why, arguments and result. The rows remain. A run still at
  work is blanked by the pass after it ends.
- Each blanked message is sent to the apps as a message written again in place, so a copy a browser or a phone kept
  goes too.
- "Continuar" on a run the prune emptied is refused: it has no transcript to go on from.

### 9. The server is told who thinks, and where

The caller statement (ADR 0181, addendum of 2026-11-16) gains `brain`, `provider`, `channel` and `thread`, so a
server can refuse to hand out what a program on a computer would keep, what would go to a provider it does not
accept, or what is asked from another conversation than the one it serves.

## Accepted

- The lock bounds where words go, not what the agent concludes or writes in its own thread.
- A read's own arguments reach what it reads: the catalog app or the listed server, and for a read on a computer or
  on a phone the computer it runs on, which keeps a local list of what agents did there for the person at it
  (`read <path>`, `looked at <path>`).
- A person can still copy a confidential message by hand, and a person's own voice message is made out by the
  speech engine before it is posted.
- What left before the mark stays where it went: a push already sent for the root, a judgment made on it, and what
  was written from its messages while they were plain (a channel's summary of its week, a memory an earlier run of
  the thread learned). Of those only the thread's own summary is archived with the mark and deleted by the prune.
- A stop said in words is not recognized in a confidential thread (the judge reads the stub): the stop button is.
- An agent's message keeps `meta` that is not its body (a card's fields, a notice's text); it reaches no model outside
  the thread (the stub carries none of it) and is blanked by the prune.
- A long work that was already going when it read a confidential result reports in its own thread, which is the
  confidential one: the statement that writes a message puts one that names no thread under the run's thread. Work
  another agent handed over reports where it runs, and the copy of that report where the person asked is the stub:
  the finding is read in the thread it was made in.
- A person who stops a run may say why, and its agent is told so where the run was (`run_stopped`): the reason is
  the person's own words, and the notice quotes nothing the run read.
- A thread's title given before the mark stays until the prune, and shows wherever a title does (the list of work
  in progress, which a connected AI app can read too).
- An approval's page shows the action's arguments as the agent typed them, a link in them included: what a person
  approves is what runs, to the letter.
- A block a person keeps in the Drive ("Guardar no Drive", `keepBlock`; a poll cannot be kept) is kept by that
  person's own hand, as a message copied by hand is. From then on it is listed, read and shared like any file of its
  channel. Search still leaves it out, and the prune takes it with the thread.
- A routine's own run that read a confidential result reports nothing: what it found stays in its run.

## Consequences

- One new table, `confidential_threads` (migration 0286, and 0287 for `thinks_with`). No setting:
  `MCP_CALLER_IDENTITY` is the switch, and the key in a result's `_meta` is the server's to send.
- Every tool call reads the run's row joined to that table (one query more, sent with the ones the call already
  made), and the message insert reads the table inside its one statement. An install with no confidential thread
  also pays one single-key read of that table in a few places off the hot path: before a judge is asked who a reply
  in a thread is for, before the conversation layer answers for a working run, for a question's or an approval's
  notification, in the learning job, in the index job of a file shown in a thread, when a run is moved to the
  background, and when a notice for an ended run would be delivered elsewhere.
- Every run's transcript keeps what it thinks with (`thinksWith`), confidential or not: a run that reads a
  confidential result mid-turn must already know it.
- A new tool is refused in a confidential thread until someone reads its handler and adds its name to the list.
- After a confidential result an agent can no longer mail, post elsewhere, message a person or another agent, write
  an issue, a page, a file, a task or a memory, run a command, use a browser or the web, write to a connected app,
  set its status line or send a GIF, in that run and in any later run of the thread.
