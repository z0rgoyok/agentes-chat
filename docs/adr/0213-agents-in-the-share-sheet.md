# 0213. The agents in the system share sheet

- Status: Accepted
- Date: 2026-11-21
- Code: the donations `apps/mobile/modules/share-suggestions` (`ShareSuggestionsModule`, iOS only) and
  `apps/mobile/src/features/share/suggestions.ts` (`suggestAgent`, `forgetSuggestions`), made on each message sent to
  an agent (`onSent` in `src/features/chat/screen/useChatSend.tsx`) and forgotten on sign-out
  (`src/features/account/index.ts`); the pick `src/features/share/picked.ts` (`suggestionId`, `pickedOfShareLink`),
  read by `ShareInbox.tsx` and chosen in `ShareScreen.tsx`; the build `apps/mobile/plugins/with-share-suggestions.js`;
  the faces `src/features/live-activity/faces.ts` (`stillFace`); tests `apps/mobile/test/share-suggestions.test.ts`

## Context

The phone app takes what other apps share through the system's share sheet: an iOS share extension made by
`expo-share-intent` opens the app with a link, and "Compartilhar com…" sends the photo, file, link or text to the agent
the person picks. On iOS the share sheet's first row suggests people to send to (a messaging app's recent
conversations, the person's contacts), and an app is there only when it tells the system who its person talks to.
Ours wasn't: sharing always took the app's icon, then a pick among every agent.

## Decision

1. **Each message a person sends to an agent is donated as a sent message.** After a message in a conversation with
   one agent reaches the server (`onSent`), the app donates an `INSendMessageIntent` whose conversation is that agent
   (`<workspace id>/<agent id>`), named by it and drawn with its still face on its night sky (360 pixels square, the
   size iOS matches pictures best from; the system cuts its own circle), grouped by the same id. "Compartilhar com…"
   sends through that conversation, so a share counts too. Apple asks for donations only as people send or receive
   messages, so nothing is donated ahead of use (no list of every agent at launch); iOS ranks the suggestions itself.
2. **A local Expo module donates** (`modules/share-suggestions`, iOS only, the Intents framework): `donate`, `forget`
   (one conversation) and `forgetAll`. A build without it (Android, an older build) donates nothing.
3. **The extension passes the pick on to the app.** The app declares the intent (`NSUserActivityTypes`), the share
   extension takes it (`NSExtensionAttributes.IntentsSupported`), and the extension's link to the app gains `&to=<id>`
   when the share came through a suggestion (`extensionContext.intent`), escaped to letters and digits.
   `plugins/with-share-suggestions.js` writes the three into the files `expo-share-intent` generates, and stops the
   build when those files are no longer as it expects, so an update of the library never ships an extension without
   suggestions silently.
4. **"Compartilhar com…" opens with the picked agent chosen**, when the pick is of the workspace on screen and the
   agent is still one the person can send to; the person can still choose another. A pick from another workspace, or
   for an agent gone, chooses nobody.
5. **Signing out forgets every suggestion**, as it ends the agents' Live Activity (ADR 0210): the next account starts
   with none, and the conversations it sends to come back as it sends.

## Consequences

- Suggestions reach phones only with a new native build, and appear after the person has sent to an agent from that
  build; iOS decides how many and which, and doesn't show them in the simulator.
- Android has its own way (sharing shortcuts); it is a separate decision.
