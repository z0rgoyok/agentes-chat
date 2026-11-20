# 0207. Agents say what they'll do before slow work

- Status: Accepted (built)
- Date: 2026-11-19
- Amends: 0010 (one line may go out before the reply: its addendum of 2026-11-19)
- Extends: 0112 (messages in a row), 0121 (long work and its `say`), 0131 (its addendum of 2026-11-19: no line of the
  server's in the agent's voice)
- Code: `packages/engine/src/say-now.ts` (`SAY_NOW_TOOL`, `SAY_NOW_MAX`, `isSayNow`, `SaidNow`, `sayNowApplies`,
  `sayNowText`, `createSayNowToolSource`, `withoutSaidNow`), `run-tools.ts` (`ToolSideEffects.saidNow`, the step
  line's words, `upFront` in `bridgeToolsFor`), `executor.ts` (`Transcript.saidNow`, `heardSaidNow`, the step's call
  order, `answerNow`, the pause's words, the final reply, `closingSummary`, `executedSince`, `UNCOUNTED_TOOLS`, the
  prompt's flag), `context.ts` (`SAY_NOW_LINE`, `QUIET_TOOLS`), `runs.ts` (`TALK_TOOLS`), `tools/run-policy.ts`
  (`HERE`, `REFUSALS.routineSayNow`), `jobs.ts` (`message.posted`), `notification-producers.ts` (`quietForPeople`),
  `agent-media.ts` (`NOT_A_LIGHT_REPLY`), `autonomy-report.ts` (`ACTED`, `SPOKE`), `context/tools.ts`
  (`STEP_NOISE`); server `apps/server/src/engine.ts`; runner `apps/server/runner/mcp.ts` (`ALWAYS_LOADED`); client
  `packages/client/src/lib/work.ts` (the block and the step line leave the call out), `realtime/receipts.ts` (the
  receipt doesn't take the line for the reply)

## Context

Between a request that takes a minute or two (a web search, a page in the browser, a few files) and its reply, nothing
the agent says reaches the chat, so the person can't tell whether it took the request.

Nothing told the person what the agent was about to do:

- **The reply is posted whole, once, at the end** (ADR 0010, amended 2026-11-10), so nothing on screen appears and
  then changes.
- **Narration is never posted.** What the agent writes between its calls is held per run and shows only quoted on the
  step line above the composer, past the turn's first 5 seconds; it is neither stored nor posted (ADR 0121, addendum
  of 2026-11-06).
- **The server no longer speaks for it.** The status line the server posted when a person wrote to a working agent is
  gone (ADR 0131, addendum of 2026-11-19): it put words in the agent's mouth. The fast reply (`talker.ts`) answers
  only once the person writes, only where the workspace has a small model, and only from what the task has done.
- **Long work has its line; shorter work has none.** `work_in_background`'s `say` (ADR 0121) tells the person at once
  that the agent is on it, but only for work of minutes. A search, a page in the browser or a few files take seconds
  to a couple of minutes and stay an ordinary turn.

So between a request and its reply the person had the step line ("Thinking…", a tool's verb): the app saying the
agent works, not the agent saying what it will do. Only the agent knows that, and only as it starts.

## Decision

### 1. One tool, one line

`say_now({ text })` posts one short line in the conversation the run answers, at once, before work that takes a
while: what the agent will do, in the person's language ("Bora! Vou abrir o navegador e já te mando."). Never a
result, a time, a question or a request for a key: the reply brings the result. It is a tool of the Tool Gateway like
any other, so every brain has it.

What people read (`sayNowText`): one line (whitespace collapsed), credentials masked (`maskCredentials`), an `@` that
would mention someone dropped (accented names too), so the line wakes nobody, and at most `SAY_NOW_MAX` (200)
characters, which the tool's schema says too. A line with a sign-in or a key in it (`scrubSignIns`, ADR 0137 §4) is
refused, not masked. A run that read outside content marks its line `meta.readOutside` as its replies (ADR 0117), so
the next agent reads it as relayed.

### 2. Where it applies

`sayNowApplies`: a run a person is behind (`runAuthority` → `person`), in a channel or a DM people read as it goes
(`movableRun`: not an agents' DM, a mission's thread, a task's or a file's conversation), not a background run (a
routine's), not background work (`workId`), outside a confidential thread (ADR 0190).

The tool is listed in every run with an id but a background one, so a run's list doesn't change as it goes (a run that
moves to the background keeps the tool and is told to use `post_update`) and the list's cached start stays the same;
where it doesn't apply, the call refuses and says why. The run policy refuses it to a routine's run on every brain
(`HERE`, `REFUSALS.routineSayNow`: what people should hear goes in `hand_off`, ADR 0053). The prompt speaks of it only
where it applies (§7).

### 3. What it refuses

Each refusal tells the agent what to do instead, and none posts anything:

- **Words not for a person**: an empty line, backticks, a snake_case name (a tool's, a function's), a path on a
  computer (`~/…`, `/home/…`, `C:\…`) or the silence word. The agent may write the line again.
- **Not here**: where nobody reads the conversation as it goes ("just do the work and answer"), in background work
  ("tell them with `post_update`"), in a mission's task, in a run that ended.
- **They wrote again**: a person's message waits unread in the run's inbox (`personAmong` over
  `pending_message_ids`). The line would answer a conversation that has moved on: the call answers, not as an error,
  that the line is skipped, and the agent reads what they said and answers all of it in one message (ADR 0112).
- **Once per run.** Under the run's row lock, a line already posted for the run (`meta.sayNow.runId`) makes the call
  answer `Already told them: "…"`. Two calls at once post one line.

### 4. The message

The line is the agent's message with no run of its own, the shape the fast reply has: author
`{ type: "agent", runId: null, hop, stretchId, forRunId }`, `meta.sayNow = { runId }`, where the run answers
(`replyThreadOf`), published at once.

- `runId` is null because a message with the run's id is its reply: the apps end the run's working row on it
  (ADR 0010). The line is said on the way.
- `hop` and `stretchId` are the run's (`runStretchOf`, ADR 0089).
- `forRunId`: the line is written for the run, so a thread sealed meanwhile seals the line too (ADR 0190).
- In the same transaction the run's row gets `answerOwed`: the line promised something, so the run can no longer pass
  or end quiet (`pass` reads it from the row, through the bridge too).

### 5. Quiet downstream

The line is neither news nor an answer; the reply is both.

- **Routing**: `message.posted` (`jobs.ts`) stops before routing: nobody is routed on the line and it wakes no agent.
- **Notifications**: `quietForPeople` holds it: no notification, no push, and outside chat surfaces (ADR 0187), which
  skip the same messages, don't carry it. The reply notifies as before.
- **Media**: no sticker or GIF follows it (`NOT_A_LIGHT_REPLY`).
- **Not an answer**: the daily stall-and-noise report (ADR 0089, addendum of 2026-10-31) counts neither the line as
  the agent speaking (`SPOKE`) nor the call as acting (`ACTED`); the reply's work block doesn't count the call
  (`UNCOUNTED_TOOLS`); what the agent recalls of its work elsewhere and of how a task was done leaves it out
  (`QUIET_TOOLS`, `STEP_NOISE`). Nor is it a fast reply: the talker's one reply per 30 s counts only `meta.talker`.
  But the talker's check that the agent already wrote after the person (`postReply`) sees it, so no fast reply lands
  on top of a line said after their message.
- **Still a conversation**: the call is a way of talking (`TALK_TOOLS`), so a run that has only said its line isn't
  at work yet (`runAtWork`, ADR 0112's addendum of 2026-11-19).

### 6. The run's bookkeeping

The tool's result carries `data.saidNow` (`ToolSideEffects.saidNow`, merged from the bridge on a computer brain) into
`Transcript.saidNow`, and `heardSaidNow` makes the line the last words people saw from the run (`lastPosted`: a reply
that is exactly the line isn't posted again) and sets `answerOwed` in the transcript too.

- **The reply doesn't repeat it.** Models often write the line again as the first words of the turn that called it,
  or open their reply with it. The final reply, the words posted with a pause (before a question's or an approval's
  card) and an answer posted early (`answerNow`, ADR 0112's addendum of 2026-11-18) drop leading sentences that are
  part of a line already said (`withoutSaidNow`: together the line's words in its order, ignoring case, accents,
  punctuation and emoji, three words or more or the whole line); what follows stays. Only finished sentences go: a
  short answer the line's words hold ("Passaram." after "te digo se passaram") and a heading that runs into a list
  stay, and a reply is never emptied unless it is a whole line again. A stopped run's words, a computer turn cut after
  its tools and a run cut by a restart drop it too, reading the lines from the conversation (`linesSaid`), since a
  computer turn's lines reach the transcript only when the turn ends. `closingSummary` (the reply when the last model
  call wrote nothing) reads only the words that came after the call, but the work called beside the line is work: a
  run that did it and wrote nothing after closes with "Done." as any other.
- **First in its step.** On the API model, `say_now` runs before the other calls of its step, whatever order the
  model wrote them in, so the line goes out before the work it announces; the results go back in the order of the
  calls. The step line shows no words for the call: they would be the line again.
- **Talk is not work done.** A computer turn that fails after only the line counts as a turn that did nothing
  (`executedNow`, `executedSince`) and is resumed or retried as one, instead of ending the run with what it did. A
  retried turn that calls `say_now` again is told it already did. Neither the model loop's count of executed calls nor
  the bridge's (`recordBridgeEffects`) counts it, and the run's calls as the follow-through judge, the repeat count
  and what an agent learns from a run read them (`runCalls`) leave it out. Another agent's run waiting in the
  conversation isn't checked for it (`scheduleParkedChecks`): it answers nothing that run asked.

### 7. Every brain, and the prompt

- The tool's scope is empty, so it is in the conversation's group every run gets, never behind tools on demand
  (ADR 0043, `directory.ts`). On a computer brain it comes through the bridge, in hand from the first round:
  `bridgeToolsFor` marks it `upFront`, so Claude Code lists it with its schema instead of behind its own tool search
  (an older runner passes the mark on), and the runner's `ALWAYS_LOADED` names it too.
- "# How you work" gets `SAY_NOW_LINE`, after the line about finishing what you start and before the long-work line,
  only where the tool is listed and applies: before work that takes more than a few seconds, say in one short line
  what you'll do, in the same response as your first work call, then work; the final message brings the result; once
  per request; never for a quick answer, nor with `work_in_background`, whose `say` is that line.

### 8. In the apps

The call is left out of the reply's block of steps and of the step line: the line itself is in the chat. The line
doesn't end the run's working row, as a fast reply doesn't, and the receipt under the person's message doesn't take it
for the answer: the reply does.

## Consequences

- A slow request reads like a colleague's: a line at once, then the result. Quick answers are unchanged.
- At most one more model step per request, when a model calls `say_now` alone instead of beside its first work call.
  The call itself is a few reads, one insert and one update, no model call.
- Models may skip it, or call it before a quick answer; a run that skips it behaves as before. How often each model
  calls it, and only before slow work, is measured with the behavior eval (`bun run eval:behavior`, slow and quick
  requests, `--repeat 3`) before anything relies on it.
- The prompt grows: the tool's definition is about 420 characters in every run but a background one, and the line of
  "How you work" about 300 more where it applies.
- One request may now bring two messages, the line and the reply. Only the reply notifies, so a person who is away
  hears once, of the result.
- No migration and no runner protocol step.

## Alternatives considered

- **Posting what the model writes before its first call.** It depends on how each model writes: some write nothing
  before a call, some a plan for themselves ("Let me check the docs first"), some in another language than the
  person's, and computer brains narrate their own steps throughout. The server can't tell a line meant for the person
  from narration; a tool call is the agent saying which is which.
- **A line the server writes** ("Working on it…", or one made from the agent's automatic status): rejected. That was
  the server's fixed line, removed by ADR 0131's addendum of 2026-11-19: words in the agent's mouth that say nothing
  of the request. The step line already says the agent works.
- **A separate reply turn beside the task**, answering at once while the task runs: more machinery (a second turn per
  request, with its own model call, its own rules and a race with the task's reply), and it can move the
  conversation: it may answer, promise or ask what the task then doesn't follow, and a message sent meanwhile would
  have two readers.
