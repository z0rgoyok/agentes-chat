# 0242. A routine comes on with connecting an app

- Status: Accepted
- Date: 2026-11-25
- Builds on: 0016 (connectors in two layers), 0038 (mailboxes), 0053 (routines), 0130 (connector events as routine
  triggers)
- Code: client `packages/client/src/lib/connect-routines.ts` (`CONNECT_ROUTINES`, `connectRoutineOf`,
  `connectRoutineAgents`, `suggestedAgent`, `connectRoutineRules`, `connectRoutineInput`, `connectRoutineMade`),
  `lib/routine-templates.ts` (templates `inbox` and `openPrs`, `mailbox`); web `components/ConnectRoutine.tsx`
  (`useRoutineOffer`, `RoutineOfferRow`, `useStartRoutine`), `ConnectFlow.tsx` (`DoneStep`), `MailConnect.tsx`
  (`WhoStep`), `layout.css` (`.cflow-routine`); phone `features/connectors/RoutineOffer.tsx`, `ConnectSheet.tsx`
  (`DoneStep`); engine `context.ts` (a routine's first run asked for now speaks); i18n `connectFlow.routine`

## Context

People connect an app (their email, Stripe, a CRM) and stop there. A routine is what shows an agent working on what
they connected without being asked, but making one means knowing Routines exists, picking a template, an agent and a
time. Asking later, in a separate step or a message from the right hand, loses most people; a longer connect flow loses
the rest.

## Decision

1. **One routine per app, fixed.** `CONNECT_ROUTINES` maps the app to a template of New routine: a mailbox (Gmail,
   Outlook, IMAP) to "Emails that need a reply", Google Calendar to the day's plan, payment apps to failed payments,
   CRMs to new leads, help desks to tickets waiting, task apps to overdue tasks, analytics apps to the week's numbers
   against the week before, GitHub to PRs waiting for review, Sentry to new errors. An app with none (a server by address, a rare app) shows nothing.
2. **On the screen that already ends connecting, on by default.** No new step: the confirmation ("Stripe connected")
   shows the routine under what it said, as a line with its switch on, what it does with the agent's name in it, and
   who does it and when as the selects of Routines (the phone: a grouped row with its switch, then Who does it and
   When as choices). Done makes it; switched off, Done only closes. A mailbox's flow shows it in "Who can use it",
   where its readers are chosen: it follows that choice, and with nobody reading the mailbox yet its switch is off and
   it says to give an agent access. A server whose tools still wait for a level shows none.
3. **It starts at once.** Made, its first run is asked for right away and a toast says so with Undo, which deletes it.
   A routine's first run asked for by a person speaks even without news (`context.ts`), so the first summary reaches
   them; later runs keep the template's report (only with news, by default).
4. **On a schedule, in my DM.** Every one runs on a schedule (twice on weekdays for email), never on each new email: a
   mail event costs a provider call each and wakes the agent for every message. GitHub's and Sentry's events need a
   webhook connecting doesn't set up (ADR 0130), so theirs check on a schedule too. It reports in its creator's DM with
   the agent: what it reads may be one person's.
5. **Who does it.** Only agents that may use the app and that I make routines for and that answer me
   (`createsRoutinesFor`, as the server's `createRoutine`), the right hand last; it starts with the first of them and
   the person picks another on the spot. A mailbox's routine picks among the agents that may read it. A role is free
   text in any language, so it picks nobody.
6. **Never twice.** A routine of mine with the template's name already there (connecting again, a second account)
   hides the line.

## Consequences

- Connecting keeps its screens and clicks; the only new choice is a switch that is already on.
- A workspace with no agent for me to make routines for sees no line.
- Mailboxes connect only on the web (the phone manages them), so the phone shows the line for catalog apps only.
- A renamed routine no longer counts as made: connecting again offers it.
- "Run now" on a routine that never ran also speaks on that run.

## Alternatives considered

- **A message from the right hand after connecting:** it reaches every way of connecting, but lands away from where the
  person is and is easy to leave for later.
- **A step of its own after connecting:** one more screen and click on every connect.
- **A routine on every new email (ADR 0130's trigger):** costly per message and noisy; a person who wants it sets it
  up in Routines.
- **Making it without showing it:** an agent reading someone's email and spending runs needs the person to see it
  before Done.
