# 0214. A channel can have agents reply in threads

- Status: Proposed
- Date: 2026-11-20
- Extends: 0032 ("One reply placement": `replyThreadOf`), 0112 (the floor and one active run per conversation),
  0190 (a run asked in the main timeline that answers under its trigger)
- Code: db `channels.reply_in_threads`, `agent_runs.reply_in_thread` (migration 0314; on by default since 0325);
  engine `runs.ts`
  (`replyThreadOf`), `run-scope.ts` (`inChannelRun`, `joinsRun`, `askedBy`, `placeAfter`, `repliesInThreadSql`),
  `messages.ts` (the `floor_runs`, `active`, `runs` and `opened` parts of `insertMessageWithRuns`,
  `postPersonMessage`'s thinking events), `dispatch.ts` (`startOrJoinRun`'s `after` and `several`, `createAgentRuns`),
  `continue-run.ts`, `run-inbox.ts` (`handOn`), `no-ai.ts` (`restartFailedRun`), `stretch.ts` (a hold's `after`),
  `parked-asks.ts`, `run-resume.ts` (`deliverNoticeToRun`), `delivery.ts`, `machine-tasks.ts`, `machine-access.ts`,
  `recovery.ts` (`activeRunsIn`), `chat-tools.ts` (`post_message`'s `move_here`), `management.ts` (`updateChannel`),
  `channels.ts` (`listChannels`);
  server `routes/app/channels.ts`, `chat.ts`; client `realtime/streams.ts` (`LiveRun.replyInThread`); web
  `ChannelPage.tsx` (the switch in the channel's details), `components/threads/ThreadLines.tsx`
  (`ThreadReplyingLine`); phone `features/chat/sheets.tsx` (`ChannelOptions`), `features/chat/cards.tsx`
  (`ThreadReplyingLink`)

## Context

Agents answer where they were asked (ADR 0032): asked in a channel's main timeline, the reply, its cards, files and
live events land there. In a busy shared channel with several agents and people, the main timeline fills with agent
output, two requests interleave, and everyone gets every answer as unread. People there want each request answered
in the thread under the message that made it, as bots do in other chat apps (issue #914).

## Decision

1. **A channel setting.** `channels.reply_in_threads`, on by default, only for regular channels (`kind = 'channel'`;
   DMs, task and file conversations keep today's behavior, and `updateChannel` refuses it there with
   `channel.reply_in_threads`; the column's value on those kinds is never read). Migration 0325 turned it on for every
   existing channel too, since the setting had no way to be chosen before then except in the hours between the two
   deploys; a channel that wants answers in its main timeline turns it off. Test databases keep the old default
   (`packages/db/test/pglite.ts`), so the tests that pin main-timeline answers stay as they are. Whoever may change the channel's topic may change it (its creator or an admin). The
   apps read it on the channel list and change it with the channel's `PATCH`.
2. **A copy on the run, and a place that goes on with it.** A run created on a message in such a channel's main
   timeline gets `agent_runs.reply_in_thread = true` (`repliesInThreadSql`, read once in the statement that creates
   it: mentions in `insertMessageWithRuns`, the router and a routine's report in `startOrJoinRun`). Turning the setting
   off or on never moves a run already made. A run that goes on from another keeps the other's place, its
   `thread_root_id` and its copy together. One function says where, `placeAfter` (`run-scope.ts`), and every run that
   goes on from another is placed by it: Continuar, the restart after "Parar e mandar", a hand-on of what a run didn't
   read (`handOn`, `startOrJoinRun`'s `after`), "Tentar de novo" on a failed run, Continuar on a stretch's pause card
   (the hold keeps the run it goes on from, `after`), asks let go while a run waits (`closeAside`), and work that comes
   back to a run that ended: a notice for it (`deliverNoticeToRun`), its computer task's end and a decision on a folder
   it asked for. When the first run answered under its message, the next one answers in that same thread, wherever its
   own trigger is and whatever the channel says now; otherwise it answers where its trigger is, as before. The
   channel's setting is read only when a request starts. What a hand-on into that thread took from the main timeline
   goes to the new run's inbox, since the run reads its thread, not the main timeline.
3. **Where it answers.** `replyThreadOf` returns the thread root, which is the trigger, when the copy is on, as it does
   for a confidential run (ADR 0190). Every run shape that calls it carries `replyInThread` (required in its `Pick`; a
   tool call's context carries the run's). `inChannelRun` is the same rule in SQL, and the inline
   `thread_root_id = trigger_message_id` checks became `inChannelRun`, so the runs that answer in the main timeline
   and the ones that answer under their trigger are told apart everywhere. Where the question is whether a message
   reaches a run, not where the run answers, the joining rule below applies (`joinsRun`).
4. **The first post opens the thread.** What such a run first posts under its trigger sets
   `threads.opened_by_reply_at`, as "Responder" does, in the same statement as the message. The channel shows the
   thread's one line: the web reads its thread lists again on any reply in a thread (`refreshRepliedThread`), and by
   then the row is there.
5. **Joining** (`joinsRun`, `run-scope.ts`). One SQL predicate says which run a message may join, from where it
   arrives: in a thread, the runs of that thread; handed on in the main timeline from a run that answered there, only
   the runs that answer there; new in the main timeline, those runs too and the asker's runs below. Every site that
   looks for a run to join calls it, and adds only which states of a run take the message: the floor and the
   active-run lookup of `insertMessageWithRuns`, `startOrJoinRun` (its own conversation, a DM, the router's join, a run
   waiting on its computer, plan or budget) and the early check of a waiting run (`scheduleParkedChecks`). A run that
   goes on from another arrives where `placeAfter` puts it, so it joins only a run in that place. A run that answers in
   the thread under a message of the main timeline takes the next messages there of whoever wrote that message, the
   person who asked (`askedBy`: the author of its `thread_root_id`), however the run went on from it: the floor and a
   new mention, while it works or waits on its computer, plan or budget. Its answer comes in the same thread. Anyone
   else's call starts a run of its own, under their own message, rather than being answered in another person's
   thread. A message in the main timeline that calls several agents (named, everyone, or the router's pick of two:
   `createAgentRuns`; for the early check, a message that started runs of more than one) joins none of their runs
   while the channel replies in threads: every agent it calls answers in the thread under it, one message and one
   thread. Messages in the thread join as before. This keeps ADR 0112's one active run per agent and conversation:
   each thread is its own conversation, so an agent called again by a message with others answers it in a second run,
   in that message's thread, beside the one it already works on.
6. **Posts that aren't answers stay in the main timeline.** A routine's report and `post_message` to another channel
   are new top-level messages; a run started on one of them answers in its thread.
7. **`move_here` is refused** for a run whose copy is on, and into a channel that replies in threads: either would put
   the run back in a main timeline the channel keeps clear.
8. **Before the first reply.** The live events go to the thread, so the main timeline would look idle. Under the
   message the web shows "Ada is replying in the thread" (`ThreadReplyingLine`, from the run's live events), which
   opens the thread, until the thread has a reply and its own line (with its working state, `ThreadInfo.working`)
   takes the place. After a reload the line reads the run's own copy, `replyInThread` on the active-run list
   (`activeRunsIn`), whose `threadId` is a channel run's root either way; never the channel's setting now.

## Consequences

- A busy channel reads as a list of requests, each with one line under it.
- Two more columns, both with a constant default: the migration rewrites no table.
- A follow-up that joined a run, then was handed on (the run stopped or ended before reading it), is answered in the
  thread of the request it joined, as are a stop-and-send, a Continuar, a retry, Continuar on a pause card and work
  that comes back after the run ended. The thread a request opened holds its whole exchange.
- An agent may have two active runs in one channel that replies in threads: one per thread. Two messages that each
  call it with others get two answers, each in its own thread, not one answer split across them.
- The person who asked keeps their run however it went on, because the thread's root names them; nothing new is
  stored for it.
- The active-run list gains `replyInThread`. Its `threadId` keeps its meaning for every client.
- The phone app does the same: the switch in the channel's ⋯ sheet, for who may change the channel, and
  `ThreadReplyingLink` under the message until the thread has its link. Both apps pick those runs with
  `repliesUnder` (client `realtime/streams.ts`).

## Alternatives considered

- **Per agent and channel, next to `autoReply`.** `@a @b` would split one request between the main timeline and a
  thread: where a reply goes belongs to the conversation, not to the agent.
- **Workspace-wide only.** An announcements channel and a client channel couldn't differ.
- **Reading the channel's setting on every post instead of copying it.** Toggling it would move runs already working,
  and Continuar on an older reply would change place.
- **Reading the setting again for each run that goes on from another.** The follow-up handed on after a stop moved to
  a new thread under itself, and a run asked before the setting was turned on went on in a thread.
- **Each site writing its own join condition.** They drifted: the floor keyed on the trigger's author, a retry placed
  under its own trigger joined the asker's run under another message, and the early check left out `several`. One
  predicate (`joinsRun`), fed by where the message arrives, keeps them the same.
- **Keying who may join on the trigger's author.** After Continuar the trigger is the agent's reply, so the asker's next
  message started a third run. `runRequester` (`cancel.ts`) names who pressed Continuar, which may be an admin, not the
  asker; the thread's root names the asker for every run that answers under it.
- **A message calling several agents joins any of them already at work, the rest answering under it.** One message
  then opened two threads, its answer split between the earlier request's thread and its own.
