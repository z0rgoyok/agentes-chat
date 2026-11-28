# 0261. In a channel, the rest of an agent's turn goes in its first message's thread

- Status: Accepted
- Date: 2026-11-27
- Extends: 0214 (agents reply in threads: `reply_in_thread`, `joinsRun`, `askedBy`, `placeAfter`), 0207 (`say_now`),
  0121 (moving a run mid-way: `adoptWork`, `moveRun`)
- Code: engine `turn-thread.ts` (`openTurnThread`, `closeEmptyTurnThread`), `executor.ts` (`post`, `placeTurn`,
  `adoptWork`, `finished`), `say-now.ts`, `run-scope.ts` (`askedBy`), `works.ts` (`moveRun`), `chat-tools.ts`
  (`post_message`'s `move_here`); tests `packages/engine/test/turn-thread.test.ts`, `apps/web/test/turn-thread.test.tsx`

## Context

In a channel whose agents answer in the main timeline (the setting off, ADR 0214), one turn often posts a short line
first ("Certo, vou levantar os números do mês.", `say_now` or text between steps) and later its long answer as a second
message in the channel. Long agent text fills the channel that everyone reads.

## Decision

1. **The first words stay; the rest goes under them.** A run a person asked in a regular channel's main timeline
   (`kind = 'channel'`, its trigger a person's message, not long work, not a routine's background run, not confidential)
   moves under its first message of its own there: `agent_runs.thread_root_id` becomes that message and
   `reply_in_thread` true (`openTurnThread`). A `say_now` line moves it at once, in the line's transaction, since work
   always follows it. The executor's own words (its `post` that is not a server note) move it on its second message:
   the first is kept on the transcript (`turnLine`), and the second goes under it in the same transaction as the move,
   so a run whose one message is its answer costs no statement more. From then on `replyThreadOf` puts everything the
   run posts in that thread: its answer, more lines, files, cards, notes, and its live events. A person's new message
   the run reads before its second message starts over (`oweAnswer` clears `turnLine`): the answer to it is a message
   of its own in the channel, as ADR 0112 has it. DMs, task, file and code conversations are never moved; a run asked
   in a thread already answers there.
2. **Who asked keeps the run.** The message carries `meta.turnThread.askedBy` (the trigger's author), and `askedBy`
   reads it when the thread's root is an agent's message, so the asker's next message in the main timeline still joins
   the run (the floor, the active-run join) instead of starting a second one. The asker follows the thread
   (`thread_follows`), so its replies count as unread for them; the answer's `agent_reply` names the thread, so the
   inbox and the push open it.
3. **One message stays as before.** A run whose only message was its answer never moves. One that a `say_now` line moved
   and that posted nothing under it goes back to the main timeline at a terminal end (`closeEmptyTurnThread`), so
   Continuar, a retry or a hand-on from it are placed as they always were.
4. **Live rows follow.** `say_now`'s move sends `agent.idle` in the main timeline and `agent.thinking` in the thread (as
   `moveRun` does) and tells the executor holding the run on any replica (`run-work:{runId}`, read by `adoptWork`, which
   now reads `reply_in_thread` too). The apps show "Ada está respondendo na thread" under the line until the thread's
   own line ("1 resposta") takes its place, with no app change: the same rule as ADR 0214 §8 (`repliesUnder`).
5. **Posts by choice are unaffected.** `post_message` to another channel posts at its top level as before. A run under
   its own line was asked in a main timeline, so `move_here` still takes it elsewhere (only a run whose root is a
   person's message in a channel that replies in threads is refused), and `moveRun` clears `reply_in_thread`.

## Consequences

- A channel reads as the agents' first lines, each with one thread line under it.
- No migration: two columns of ADR 0214 and a key in the message's meta.
- A question or approval card a run asks after its first line is in the thread, as everything else of the turn; the
  thread line shows that it needs someone, and the card notifies as before.
