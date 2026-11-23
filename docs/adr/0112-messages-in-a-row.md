# 0112. Messages in a row: a burst is one request, a message mid-task updates it

- Status: Accepted
- Date: 2026-11-01
- Code: `packages/engine/src/burst.ts` (`waitForBurst`), `executor.ts` (the wait before the first turn, `deliverSteering(beforeStart)`, `widenRequest`), `live-steer.ts` (`renderSteered` `beforeStart`), `context.ts` ("# How to reply"), `steering.ts` (live delivery only for computer brains), `talker.ts` (`talkerPolicy`), `apps/server/src/engine.ts` (`quietMs`)

## Context

People write to agents the way they text: "oi" / "preciso de uma coisa" / "olha o relatório de ontem e me diz se bate com o quadro", seconds apart, or "ah, e inclui a semana passada também" while the agent already works. A beta user reported that agents get lost when that happens.

What already held (ADR 0029): one active run per agent and conversation. A person's message to an agent that is queued or working goes into that run's inbox (`pending_message_ids`, `insertMessageWithRuns`), in a DM, a thread, a channel with the mention, and as a follow-up without @ to the agent still answering that person (the floor). The router waits `ROUTER_QUIET_MS` for the same person's next message and decides once on the run of them. The executor reads the inbox before every model call and before ending (an answer written while someone wrote is posted, then the run goes on), a computer brain mid-turn takes it live (Claude Code at its next tool boundary, Codex's app-server at its next request) and whatever it never confirmed is read with its next turn, and every ending hands unread messages to a run of their own. So no second parallel run and nothing lost.

What went wrong:

1. **A burst was answered piece by piece.** A mention or a DM starts its run at once. The worker picks it up in milliseconds and the first model call reads "oi" alone: the agent answers "Oi! Em que posso ajudar?", then reads the rest and answers again. On a computer brain the first turn ran on "oi" alone too.
2. **The rest of a burst read as news.** What joined the inbox before the first call was rendered "[New message from Ana, while you were working]", for a run that hadn't started working.
3. **Nothing told the agent how to take an update.** It got the line, but no rule saying it changes the task in progress.
4. **The judges held the reply to the first message only.** The follow-through verdict reads the request as the trigger's body, so for a burst that was "oi", and for an update it was the plan before it.
5. **The second message could hang its own send for 3 s.** The send asks the executing instance to deliver live to any running run, and waits up to `LIVE_STEER_WAIT_MS` for an answer. A model-brain run never takes messages live, and while its executor was still starting (exactly when the rest of a burst arrives) nobody answered.
6. **"Anotado, leio assim que terminar este passo."** The conversation layer treated a computer-brain run as busy from its first second, so the second message of a burst could get a "noted" for a request the run was about to read.

## Decision

1. **A short quiet window before the first model call.** A run started on a person's message (not background, no turn yet) waits until that person has been quiet in the conversation (same channel, same thread or main timeline) for `quietMs` (`ROUTER_QUIET_MS`, 2.5 s, on a server; off in tests unless set), capped at four windows from the trigger. The wait is measured from the messages' own times, on the database's clock (they are stamped by its `now()`; the app's clock may drift from it), so a run that starts late (the router already waited, a busy worker) waits only what is left, usually nothing, and a lone message waits at most the window. It sits after the context is built and the live-steering listener is up, inside the run's error handling (a failed query on the last try fails the run), and the app already shows the agent thinking. A routed run skips the wait (its trigger is already the last of the burst, so the query could change nothing), and Parar or a shutdown drain ends it at once. Its cost on a mention or DM run is one `SELECT` (the person's latest message time plus the database clock), and one more per window it waits, at most five: a statement on an indexed range per run, against a model call that would otherwise read "oi" alone.
2. **One run reads the whole burst.** The follow-ups join the run's inbox as before; the first loop step reads them, rendered as plain conversation lines ("[Ana]: …") because they came before it started. A computer brain gets them in its first turn's prompt. Receipts are the usual ones (`agent.run.steered` on send, `agent.run.read` when read).
3. **A message mid-task updates the task.** The system prompt says so: messages in a row are one request, answered once; one that comes while the agent works changes course (a correction) or widens it (an addition), and the agent says in a few words that it took it. Delivery is unchanged: the model brain reads it before its next call (or "Parar e mandar" cuts the call), a computer brain live or with its next turn.
4. **The request grows with what the person adds.** Each message the run reads from its inbox (between turns or live) is appended to `transcript.request`, which the follow-through verdict and Continuar read.
5. **Live delivery only for computer brains, answered at once while starting.** The send asks for a live delivery only when the run thinks with a computer brain (`runBrainOf`); a model-brain run reads its inbox at every step anyway. From the moment an instance claims a run until its live-steering listener is up, that instance answers "no turn" at once (`answerNoTurn`), so a send to a computer-brain run that is still starting doesn't wait `LIVE_STEER_WAIT_MS`. Only the owning instance answers, so it never races a live "yes" from another.
6. **The conversation layer leaves a computer brain's first seconds alone.** A computer-brain run that started less than `TALKER_QUIET_MS` ago is `reads_soon`, as a model-brain run with a recent step is.

Autonomy rules are unchanged (ADR 0097): nothing here grants anything, starts work nobody asked for, or keeps a turn going; the window only delays the first call of a run a person started.

## Consequences

- A lone message to an agent starts its first model call up to 2.5 s later than before (less the time to build the context). Bursts get one answer.
- A message that arrives after the window, while the first call is under way, is still read right after it: the first answer is posted and the run goes on with the rest, as before.
- The runner and the brains didn't change: everything happens in the engine before a turn starts. Mid-turn delivery on the runner side (Claude Code's stdin message and its read receipts, Codex's `turn/steer`) is the existing protocol 15 path, covered by the runner tests with the fake CLIs (`apps/server/test/runner/brain.test.ts` "Live steering", `brain-codex-app.test.ts`); the engine side of a mid-turn update (read receipt, widened request) is covered in `packages/engine/test/live-steer.test.ts`.
- A message sent while a computer brain's CLI is still starting (Claude Code before `system/init`, Codex "is starting") no longer waits for the whole CLI turn: when the turn becomes steerable, the listener hands it what waited in the inbox, and while the runner answers `no_turn` it asks again every `LIVE_STEER_RETRY_MS` (1 s, at most 30 times) as long as the same turn is in flight, stopping on delivery, a refusal (`unsupported`), the turn's end or the run's close (`live-steer.ts`). Receipts and the widened request are the usual ones.

## Alternatives considered

- **Joining later messages into a queued run only** (no wait): the worker claims a run in milliseconds, so the burst almost never finds it still queued.
- **Waiting on the person's typing indicator**: precise on the web, but the phone and API clients don't send it, and it would tie the executor to presence. The quiet window works for every client.
- **Holding the first answer when a message arrives during it** (post one combined answer): drops a reply the model already wrote and makes the next one refer to text nobody saw.

## Addendum (2026-11-18): on a computer brain, each answer is its own message, as it comes

What a model brain already did (an answer written while someone wrote is posted, then the run goes on) a computer brain didn't. When Claude Code's turn ended while a message handed to it mid-turn was still queued, the runner kept that answer, waited for the CLI's next turn (the one that reads the message) and joined both answers into one `done`, so the person got two answers glued in one message, and the first one only after the second was written. Codex's app-server did the same with the answer of a turn an urgent message ended. This is the third alternative above, which this ADR rejected, happening on the runner.

Decision:

1. **The server asks for each answer** (`BrainTurnRequest.answers: "each"`, no protocol step: a runner that doesn't read it joins as before). The runner then sends the answer of a CLI turn the request goes on from (a message still queued, work moved to the background, a background task's notice; for Codex, a turn an urgent message ended) as an `answer` event as soon as the CLI ends it, redacted like `done`, and `done` holds only what came after it (nothing when no next turn came).
2. **The engine posts it at once** (`answerNow` in `executor.ts`), before reading anything the brain says after it, where the run answers, as its own message, and records it in the run's conversation before the message read next. What streamed before it is no longer the turn's text (`answered`), so a stop, a pause or the restart sweep never posts it again.
3. **Held back where the turn's end would hold it back.** Only a conversation's run posts early (a routine speaks through its hand-off, long work's report goes home, a mission's and an agents' DM's answers are read whole). The silence word alone or the last message word for word is nothing to post; words the silence word closes, our tools named to a person, or a follow-through verdict of `secret`, `unbacked` or `untried` keep the answer for the turn's end, where it leads the final answer, joined as before, and the usual rules apply to the whole.

Consequences: the person reads the first answer while the agent works on the next; the second answer comes in a message of its own. One follow-through judgment more per early answer, only when a message arrives mid-answer. Covered by the runner tests with the fake CLI (`apps/server/test/runner/brain.test.ts`, "the server takes each answer as it comes…") and `packages/engine/test/live-steer.test.ts` (two messages in order, the secret held back).

## Addendum (2026-11-18, 2): the triage of a message sent mid-task

Until now every message a person sent an agent at work went the same way: into the task, read at its next pause, answered with the task's end. The exceptions were the person's own: "Parar e mandar" to cut the step, and a plain "stop", which a separate Noul judged. That judgment missed the plainest stop of all: with the engine's own state, Jev put "para" at 0.05 and "para!" at 0.59 against a 0.6 bar, so typing "para" never stopped the agent.

Decision:

1. **One judgment says how the agent takes the message** (`steerHandling` in `judge.ts`, kind `steer_triage`): a Choice among `stop` (drop the task), `interrupt` (a correction that makes going on a waste, an urgent problem: read it now), `add` (a detail for the same task: the next pause, as before), `answer` (a greeting, a question about the work: a short reply now, the work goes on) and `queue` (a separate request: after the task, in a run of its own). Its state is the agent's name, what it works on (its request, grown with what the person added, else its trigger) and the message. A way less likely than `STEER_SURE` (0.6) is `add`, so a judge that isn't sure, fails or is off changes nothing. It runs after the send, never in its way, and never for a run of a confidential thread (the judge refuses, ADR 0190).
2. **What each way does** (`steering.ts`): `stop` cancels as before. `interrupt` cuts a model brain's call (`interruptRun`, as "Parar e mandar"); a computer brain mid-turn now gets the message only once the triage said how, a moment after the send: urgent for a correction, and a turn that can't take it now is stopped and started again from it. `queue` takes the message out of what the task's steps read into `agent_runs.after_message_ids` (migration 0306, `queueAfterRun`); every ending hands it on with the unread messages (`takeToHandOn`), the sweeper too, and a run that pauses on what a message can't move hands it on at once. `answer` and `queue` get the fast reply at once (`talkerPolicy` no longer waits for a quiet run), which for a separate request says it's noted and comes after the task (`snapshot.afterTask`). Without a judge everything is as before.

Measured before shipping on 52 messages written for it (synthetic, no conversation of anyone's): 49 right (94%), every stop, correction and addition right; the three misses were follow-ups on the same file taken as additions and an off-topic quick question taken for after the task, all under 0.45 confidence. About 300 ms and 740 input tokens a message.

Consequences: a message sent mid-task costs one Jev call, as the stop check did (that one asked only for short messages). A separate request is answered in its own message after the task instead of inside its final answer. A misjudged `interrupt` costs a cut step, or on a computer whose turn can't take messages a restart from the message, the same as the person pressing "Parar e mandar".

## Addendum (2026-11-19): a conversation answers what it was told while it answered

A reply could go out after the conversation had moved on. While a run that had only greeted the person was still writing, they asked for something, and the greeting was posted as if the request had never come; only the next turn took the request up. With the triage on, the request would also have been left for "after the task" of a run that had no task.

1. **A run is at work once it calls a tool** (`runAtWork` in `runs.ts`), other than a way of talking (a reaction, a question card, its background works' own tools). Until then it is a conversation.
2. **A conversation takes what is added** (`steering.ts`): while the run only talks, the triage's `answer` and `queue` are read with its next step like `add`. Nothing is left for after it (`after_message_ids`), and the fast reply doesn't speak for it: the run itself answers in a moment. `stop` and `interrupt` act as before.
3. **An overtaken reply is rewritten, not sent** (`executor.ts`, the turn's end): when a turn of a run that only talks ends with a short reply (`OVERTAKEN_MAX_CHARS`, 200: a greeting, a quick answer) and a person's message came while it was written (unread, `personAmong`), the reply isn't posted. A longer one is substance (an explanation, a result): it goes out, and the next turn answers what came, as a person would send what they wrote and then answer the follow-up. The next turn reads the new messages after a note with its unsent draft (`overtakenNote`) and answers all of it in one message, as a person who sees new messages before pressing send would. At most twice in a row (`OVERTAKEN_MAX`, `transcript.overtaken`), so someone who keeps writing still gets an answer; never for a run at work (its reply is a result, and goes out), background work, a mission or an agents' DM. A computer brain that reads messages mid-turn (Claude Code, Codex) is unchanged: each of its answers goes out as it comes (addendum of 2026-11-18).

Consequences: messages in a row sent while the agent writes get one answer that reads all of them, on every brain whose turn ends before it reads them (the API model, OpenCode, Cursor and the others). The rewrite costs nothing extra: the next turn ran anyway to read the new messages.

## Addendum (2026-11-19, 2): in a channel, a line for someone else isn't the agent's

In a channel others share, a message joins an agent's task without @mentioning it in two ways. The floor takes the follow-up of the person it works for, in the main timeline, within 30 minutes (`floor_runs` in `messages.ts`). In a thread, a reply joins when that person writes there or the agent spoke last (`talkingTo`). Both are deterministic, and the router never sees those messages. So when the person who asked turned to a colleague, by name or @, the line went into the agent's task as theirs. The triage only asked how the agent takes it, never whether it was for the agent. The run then made it part of the request and owed an answer to it (`widenRequest`, `oweAnswer`), and the follow-through judge held it to that answer. Reading the message turned into answering it.

1. **The triage also asks whether it is for the agent** (`steerHandling` `elsewhere`, in the same call, at no extra cost).
   - **When it is asked:** only where the message could be for someone else (`sharedConversation` in `steering.ts`): a person's message in a channel (not a DM, a task's conversation or a mission's thread) that neither @mentions the agent nor quotes it, not sent with "Parar e mandar".
   - **What the judge sees:** whether the person who asked for the task wrote the message, or someone else in the channel did (`written_by`).
   - **How sure it must be:** `ELSEWHERE_SURE` (0.75), above `STEER_SURE`. An unsure judge leaves the message to the agent as before, because a follow-up of theirs the agent never reads costs more than a line it reads and leaves.
2. **A line for someone else leaves the task unread** (`releaseFromRun` in `run-inbox.ts`):
   - It comes out of the run's inbox and out of the message's `steeredRunIds`, so a reload's receipts, who wrote into the run, and the router's history no longer count it as sent there.
   - The app hears `agent.run.released`, and the receipt says the agent saw it.
   - The router decides who answers it (`ROUTE_RELEASED_JOB`, through `routePersonMessage` in `jobs.ts`), as for any message nobody mentioned, so it may go to nobody. The agent it left isn't a candidate (`routeMessage`'s `except`): the router leans toward the agent the person was just talking to (a lower bar for it), which would hand the message straight back. And only an agent the message speaks to answers it (`forSomeoneElse`: the step's addressee, or an agent it names), never the agent best placed to answer nor one a rule supplies (R5's "a message for the agents always gets one", the channel's one agent, a follow-up, a step's failure), since the triage already found it for someone else.
   - Nothing is posted for the agent, and no fast reply speaks for it.
3. **The run waits for the triage a moment** (`awaitTriage` on `takeInbox` and `unreadNow`).
   - **Why:** a computer brain mid-turn already got such a message only once the triage said how (addendum of 2026-11-18, 2), but the API model reads its inbox at every step and could take the message before the judge answered.
   - **How:** a message under triage carries `meta.triage` (`markTriage`, cleared once the decision is acted on). A step, and a turn's end checking for new messages, wait while one in the inbox does, never past `TRIAGE_GRACE_MS` (2 s) from its send. The check rides on the inbox read the run already makes, so nothing under triage costs no statement.
   - **What it doesn't cover:** a message the run read before the judge answered stays read, as any message the run read.

Consequences:
- In a channel, an agent at work no longer answers what the person who asked said to someone else, nor people chatting in its thread.
- Where it can only be for the agent (a DM, an @mention, a quote, "Parar e mandar"), nothing changes.
- Without a judge, nothing changes.
- An API-model step may wait up to 2 s for a line just written in its channel.
- A wrong `elsewhere` is a follow-up that agent doesn't read; the router may give it to another agent, or to nobody.
- Covered by `steer-triage.test.ts`. The triage eval (`eval/steer-triage.ts`) adds 20 channel lines: none for the agent may be taken for someone else's, and 80% of the lines for someone else must be.

Measured before shipping with Jev on the eval's 72 lines (written for it, no conversation of anyone's): 67 right (93%).
- Not one line for the agent was taken for someone else's, including those that name a person.
- 8 of the 10 lines for someone else were caught. The two missed were lines to the whole group, which the agent reads as before.
- The 52 earlier lines came out as before (49 right).

## Addendum (2026-11-19, 3): the line before slow work

ADR 0207 lets a run post one short line of what it will do before slow work (`say_now`), and the line keeps to this record: while a person's message waits unread in the run's inbox it isn't posted (the run reads the message next and answers all of it in one message, so the line never answers a conversation that has moved on); the call is a way of talking (`TALK_TOOLS`), so a run that has only said its line is still a conversation (`runAtWork`, the addendum above); and an answer posted early (`answerNow`) or at the turn's end drops leading sentences that only repeat the line (`withoutSaidNow`).
