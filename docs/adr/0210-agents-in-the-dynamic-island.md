# 0210. Agents at work in the iPhone's Dynamic Island

- Status: Accepted
- Date: 2026-11-18
- Code: `apps/mobile/src/features/live-activity/*` (the Live Activity, its faces and its registration),
  `packages/engine/src/live-activity.ts` (what the island shows and when it is sent), `packages/adapters/src/push-apns.ts`
  (the Live Activity push), `apps/server/src/routes/app/push.ts` (the registration). "Live activity" in code: the app's
  "island" is already its in-app notice island (ADR 0071).

## Context

A person asks an agent for something and goes on with their day. While the agent works they had to open the app to
know where it stood. The iPhone has a place for exactly this: a Live Activity, shown in the Dynamic Island and on the
Lock Screen, which the system draws from the app's layout and which a server can update with the app closed.

## Decision

1. **One Live Activity per person, never one per agent.** It shows the agents working on what that person asked
   (their runs, as `authority.ts` tells who is behind one, in every workspace they are in; routines stay out) and
   the requests waiting for them: the waiting rows of their inbox (ADR 0172) for an approval, a question or a secret,
   so a request shows for whoever is notified of it, and marking it done or snoozing it takes it off. Up to three
   agents, a request waiting first, then the most recent. What an agent does is its status line (ADR 0084) when it
   belongs to that run, else "working" or "in line". It says "done" ("Pronto") for a few minutes once nothing is left,
   then the system removes it.
2. **The layout is the app's, in iOS's own components** (`expo-widgets`, Expo's package; `@expo/ui`'s SwiftUI
   views). The faces are PNGs the app writes to the app group's widgets directory (`faces/<agentId>.png`); the
   layout reads them by path. No animation of ours runs there: a face, words and the system's own timer.
3. **The server is the one that knows, and it sends everything.** A job (`live-activity.refresh`, coalesced, by
   person or by run: a run's hooks enqueue its id and the job finds its person) computes what the island shows
   whenever a run of theirs starts, waits, moves on or ends and whenever their inbox changes (`publishCounts`), only
   when some phone on the server registered, and pushes it to Apple with the Live Activity push type (`apns-push-type: liveactivity`, topic
   `<bundle id>.push-type.liveactivity`), straight with `APNS_KEY` or through the push relay, as the other iPhone
   pushes (`PUSH_SENDER`).
   - With no activity on the phone, a **push-to-start** (iOS 17.2+) starts it, with the system's alert the first time.
   - With one, an **update** carries the new content, only when it changed and at most every 5 seconds unless what
     it says turns (a request, done); it goes stale after 30 minutes and is sent again every 20 while still right.
     When nothing is left, a last update says "done" and an **end** with a dismissal date 4 minutes on removes it.
   - Two jobs never send to one phone at once: each takes the device's row by compare-and-set first.
4. **The phone tells the server where to send.** The app registers, per install (`installId`), the push-to-start
   token, the running activity's id and push token, its widgets directory, its bundle id, whether it is a sandbox
   build and its language (`POST /api/app/push/live-activity`); it removes them when the person turns it off
   (`DELETE /api/app/push/live-activity`). A push-started activity's own token reaches the app only when the app runs
   (`expo-widgets` hands it over through the activity's instance), so the app registers its activities every time it
   comes to the foreground and every 15 seconds while it is open, keeping one activity (a second one, from a start
   sent again before the first one's token arrived, ends). Until then the server cannot update that one activity;
   a start goes stale after 10 minutes so the system dims it instead of showing old news as current, and the start is
   sent again only after those 10 minutes. Signing out of a server removes the registration and ends the activities.
5. **The content** is the activity's `name` (`AgentsActivity`) and its `props`, a JSON string (the shape
   `expo-widgets` reads):

   ```ts
   interface IslandProps {
     v: 1;
     /** "working": agents at work; "waiting": a request waits for the person; "done": nothing left. */
     tone: "working" | "waiting" | "done";
     /** The first line: an agent's name, "Iris pede aprovação", "2 trabalhando", "Pronto". */
     headline: string;
     /** What stands at the closed island's end instead of the first agent's timer ("Aprovar?", "2 trabalhando"); null: the timer. */
     trailing: string | null;
     /** Up to three, a request waiting first, then the most recent. */
     agents: {
       id: string;
       name: string;
       /** file:// path of its face in the widgets directory, or null. */
       face: string | null;
       /** What it is doing now, or the request in one line. */
       step: string;
       /** Since when (ms since the epoch): the system's timer counts from it. */
       since: number;
       state: "working" | "waiting" | "done";
       /** "#channel", a DM's name or the workspace. */
       where: string;
     }[];
     /** Agents working beyond the three shown. */
     more: number;
     /** Where a tap goes: agenteschat://island?org=…&channel=…[&thread=…][&message=…]. */
     url: string;
   }
   ```

   The words are the person's language (`locale`), made on the server as the other push texts (`push-messages.ts`).
6. **A switch, on by default:** Você › Notificações › "Agentes na ilha". Off, the app removes its registration and
   ends its activities.

## Consequences

- The iPhone app gains a widget extension (`chat.agentes.app.ExpoWidgetsTarget`, in the app group
  `group.chat.agentes.app`), so it needs a new native build, and the App Store build signs a third target.
- iOS 17.2 or later to start with the app closed; on older versions the island stays off.
- The Live Activity push budget is Apple's: updates are coalesced per person and only sent when what shows changes.
  Through the push relay each token gets 720 an hour, counted in the installation's share.
- A self-hosted server reaches the store's app through the push relay (`POST /api/push-relay/v1/live-activities`); a
  relay that predates it answers 404 and the island stays off there.
- Android has no equivalent here; its ongoing notification is a separate decision.
