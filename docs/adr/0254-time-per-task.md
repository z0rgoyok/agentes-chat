# 0254. Time per task: each ask's kind, its times and a speed index

- Status: Accepted (built: the server's judgment and the operator API's read, for an operator's console to chart)
- Date: 2026-11-26
- Builds on: ADR 0089 (stretches), ADR 0127 (the operator's work analytics), ADR 0084 §8–9 (a run's start judgments)
- Code: engine `asks.ts` (`judgeAskKind`, `recordAskKind`), `ask-times.ts` (`operatorAskTimes`), `executor.ts` (the
  start group's `ask_kind`), `judge.ts` (`startJudgmentState`); server `operator/analytics.ts` (`GET /analytics/asks`);
  migration `0359_ask_kinds`; eval `packages/engine/eval/ask-kinds.ts`

## Context

The reply times (`GET /analytics/reply-times`) time a run: from the message that started it to its first message. A
person doesn't wait for a run. They wait for what they asked: a greeting should be answered in seconds, a report may
take minutes, and work one agent hands to another is still the same ask. A median over every run mixes all of them, so
a "hi" that took a minute hides behind long tasks that did fine, and a fix for one kind of ask can't be seen.

## Decision

1. **An ask is a person's message and its stretch.** Every run and message a person's message sets off carries that
   message as its stretch (ADR 0089), the hand-offs to other agents and their follow-ups included, until a person acts
   again (which starts a new ask). An ask is read from the runs of one stretch whose root is a person's message;
   background runs (routines) are no one's ask.
2. **Jev reads its kind when its first run starts**, in any language: `chat` (small talk), `question` (answerable from
   what it knows), `lookup`, `action` (one specific thing), `task` (several steps, minutes) or `project` (hours, or
   background work). The question goes in the run's start request (`JudgeGroup`, with Automático's, the tool groups'
   and the status line's), with the status line's state, so it adds no round trip and nothing waits on it. Calibrated
   only, kept at 0.5 or more (`ASK_KIND_SURE`) in `ask_kinds` (one row per ask, the first agent's read). Without Jev, in
   a confidential thread, or below the bar, the kind is read from what the work did: no tool and at most 15 characters
   is `chat`, no tool `question`, 1 to 3 tool calls `lookup`, more `task`.
3. **Its times are read back, nothing more is written**: from the person's message to the first activity (a tool's step
   or a message), to the first reply (the work's first message; the server's own notices, such as no AI or a plan at
   its limit, aren't one, as for the reply times), and to done (every run of the stretch ended, and its long work if it
   stepped into one). How it ended: `done`, `failed`, `setup` (no AI, a hold or a spent budget, before any reply),
   `canceled` by a person, `open`, `passed` (every agent passed).
4. **A speed index**, Apdex-style, per kind's target for the first reply (`ASK_TARGET_MS`): chat 5 s, question 10 s,
   lookup 20 s, action 30 s, task 2 min, project 1 min (long work should say quickly that it took the work on). A reply
   within the target satisfies, within four times it tolerates, later frustrates; the index is satisfied plus half the
   tolerated over the asks that count, 0 to 100. A failure, and an ask still without a reply past four times its
   target, count against it; a setup, a person's stop, a pass by every agent and an ask still within its time don't
   count, so failures can't make the times look better and a workspace with no AI doesn't read as slow.
5. **`GET /analytics/asks?from&to[&bucket][&orgId]`** under the operator token: up to 31 days, across workspaces or in
   one, with the totals, each kind (in order, with its target), by brain and by model of the ask's first run (the 20
   with most asks), and a series per UTC hour or day for all asks and each kind. Counts and times only: no message, no
   name. It reads the window's runs once, one row per ask, and sums them in the server.

## Consequences

- A slow greeting shows as a slow greeting, beside the kinds that did fine, per brain and model, by the hour.
- One more question in a run's start request to Jev, and one small row per ask.
- An ask a person joined while its run worked moves to the newer message's stretch (ADR 0089 §2), so it is timed from
  that message.
- The kinds' criteria and the bar are held by `bun run eval:ask-kinds` (six languages, a short go-ahead read with what
  came before), which runs before any change to them.
