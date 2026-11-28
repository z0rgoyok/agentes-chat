# 0100. Voice messages

- Status: Accepted
- Date: 2026-10-31
- Code: `packages/adapters/src/speech.ts`, `packages/engine/src/speech-settings.ts`, `packages/engine/src/voice.ts`, `packages/db/src/schema/voice.ts`, `apps/server/src/routes/app/voice.ts`, `deploy/speech/server.py`

## Context

People want to talk to agents, on the web, the desktop and the phone. Models take text, not audio. To the person it should feel like sending audio; turning it into text is an internal step.

## Decision

### 1. The message is the audio; the agent reads its words

We keep the recording and the apps show a wave and a player. The words go in `messages.body`, so routing, mentions, context, memory and search work as for any message, and `meta.voice` (`clipId`, `durationMs`, `peaks`, `expiresAt`, `noWords`) says it is a voice message.

### 2. Words only in the message itself: one line under the wave, the rest on request

On the message itself, one line of the words sits under the wave, in the player's card, and opens in full there; they come from `message.body`, so they stay in the API. Everywhere a message is listed, they don't appear: channel and DM previews, thread titles and excerpts, notifications, push, quotes and search snippets go through `readableBody` and say "voice message" in the reader's language (`mediaKind: "voice"`). A voice message is found by its words and shown as its audio. When no engine could make out the words, `body` holds a placeholder for the agent and `meta.voice.noWords` is true, so the apps never offer it as text.

### 3. One interface, swappable engines

`SpeechEngine` is a small adapter per provider: AssemblyAI, ElevenLabs, Soniox, and the OpenAI format for OpenAI, Groq and a server of one's own. Engines are tried in order (`SPEECH_ENGINES`), the next one taking over when one fails. The workspace's names (agents, people, channels) go with every call, so nobody keeps a vocabulary list. With no engine, the microphone stays hidden and the server still needs only Postgres.

A server of one's own is told more than a provider ever is: the workspace each recording comes from (`X-Agentes-Org`), so one server can route or count by workspace, and, with `LOCAL_SPEECH_WARM=on`, that someone is about to record (`POST /warm` when the app asks whether it may), so a model loaded on demand is ready when the recording arrives. Every server of the OpenAI format gets half a minute plus twice the recording's length to answer; past that it counts as busy and the next engine tries.

The key is the server's, not the workspace's. On agentes.chat's servers it comes from the environment and nobody chooses. Elsewhere the installation's owner may also pick a provider and paste its key in Settings, kept like the Jev key (ADR 0073): sealed, tried with a second of silence before it is stored, never returned.

### 4. The finished recording first

The app sends the finished recording and shows it at once. The server stores it, answers, and a job (`voice.transcribe`) gets the words and posts the message through `postPersonMessage`, so what was said survives a closed app or a provider's bad minute, and a resend with the same `clientId` writes nothing new. It is also the only path that needs no new native module on the phone. Nothing said drops the recording and tells its sender (`voice.dropped`). After every try fails, the message still goes, as audio people can hear.

Streaming audio while the person speaks would make the words ready on release. It is left for later, as another method on `SpeechEngine` next to `file`.

### 5. Recordings as they came

The server stores the app's recording as is, with no transcoding, so it needs no encoder in the image. Only audio types are accepted, since they are served back from our own address.

### 6. Outside the Drive

A recording is part of its message, so it lives in `voice_clips` on the workspace's storage (`BlobStoreResolver`), not in `artifacts`. Who can read the channel can play it. It counts in `storedBytes` and moves in a storage migration.

### 7. Fair use, invisible

On agentes.chat's servers only: a person and a workspace have a number of minutes in a rolling 24 hours (`VOICE_LIMIT_*`, 60 per person; 20 per member, at least 300, per workspace; 0 turns one off). It is checked before a recording starts and when it arrives, never cutting one short. Nobody sees a counter or a price. It is counted from `voice_clips`, not `usage_records`, so nothing reaches the Usage screens. A self-hosted server has no limit.

A workspace on a billing hold (ADR 0079: no plan yet, a failed payment, an ended plan) gets no words at all: `GET …/voice/allowed` answers `{ allowed: false, reason: "plan" }` and a recording is refused with 409 `voice.plan` before anything is stored, so the server's engines only ever work for a plan in force. The apps say voice comes with a plan and give the way to one. Only a billing service sets such a hold, so a server without one never meets it.

### 8. Recordings expire

`VOICE_RETENTION_DAYS` (default 90; 0 keeps them forever) applies on every server, so storage doesn't fill up. A daily sweep deletes the audio in pages and sets `voice_clips.audio_deleted_at`. The row stays, as fair use counts it, and so does the message with its words. A recording waiting for its words never expires. The audio route answers 410 `voice.expired` for a swept recording or one past its date; swept recordings leave `storedBytes` and aren't copied by a storage migration. `meta.voice.expiresAt` is written when the message is posted, so a later change of the setting applies on the server but doesn't rewrite that date.

## Consequences

- Recordings hold people's voices and go to the chosen provider; `SELF_HOSTING.md` says so, and a server of one's own keeps them in.
- Agents aren't told yet that a message was spoken: a change to their prompt needs an eval first.

## Addendum (2026-11-07): Parakeet on our own server, the language heard in the audio

**The decision.** agentes.chat's Cloud turns voice into text on its own production server: NVIDIA's Parakeet TDT 0.6B v3
(int8, on ONNX Runtime) in the compose file's `speech` profile (`deploy/speech`), with `SPEECH_ENGINES=local,deepinfra`.
When that service is busy, down, or not for the language spoken, DeepInfra's `whisper-large-v3-turbo` takes the
recording, the cheapest hosted engine (below). No model runs on the workspaces' computers, which are the agents' to work
on. Published measurements on 2 vCPUs give Parakeet about 6 s per minute of audio, about 3 s end to end for a short
note, and 1.2 to 1.8 GB of memory; our own server's numbers come from a benchmark run there.

**DeepInfra after our server.** The engines are assemblyai, elevenlabs, soniox, groq, openai, local and deepinfra, and
with `SPEECH_ENGINES` empty every one with a key is tried in that order. DeepInfra (`DEEPINFRA_API_KEY`) speaks the
OpenAI format (`https://api.deepinfra.com/v1/openai`) and runs the same Whisper as Groq (`openai/whisper-large-v3-turbo`)
for $0.012 an audio hour, billed by the second, where Groq asks $0.04 and bills 10 s at least. A test with a real key
turned a 4.4 s Portuguese note into the right words in 1.8 s, for $0.0000146, about 7.6 times less than Groq bills for
it, and past 10 s DeepInfra costs 3.3 times less. Groq can still follow it (`SPEECH_ENGINES=local,deepinfra,groq`) for
the minutes DeepInfra is busy.

**The language comes from the audio.** The apps send their interface language, and someone with the app in English may
speak Portuguese. Engines that detect the language themselves (Groq, DeepInfra, OpenAI, AssemblyAI, ElevenLabs and our
own server) no longer get it: Whisper takes `language` as an order, so the words came out wrong or translated. Soniox
still gets it, as `language_hints`, which is a hint. Our server never reads it: Whisper tiny guesses the language from
the first 30 s, and when the shares of Parakeet's 25 European languages add up to `SPEECH_LANGUAGE_MIN` (0.7) or
more, Parakeet transcribes; it detects which of them by itself. Anything else, or a guess that unsure, answers 422
`unsupported_language`, which the adapter reads as `refused`: the next engine tries at once, in the same attempt, and
with no next engine the message goes out as audio with no words, as for any refusal. A recording with no signal at all
(a muted microphone, the silent second a key test sends) has no words and runs no model. Parakeet hearing no words in
one that has sound answers 422 `no_words` the same way, since the core drops a recording whose words are empty as
silent, and a slip of ours must not lose a message. The core gives up on a recording only when every engine refused
it: an earlier engine that was busy still earns a retry, whatever the order. Parakeet takes no prompt, so the
workspace's names don't steer it as they steer Whisper.

**The overflow.** The service runs `SPEECH_WORKERS` recordings at once (2) on `SPEECH_THREADS` threads each (2; one
alone gets them all), within `SPEECH_CPUS` (4) and `SPEECH_MEMORY` (4 GB). Up to `SPEECH_QUEUE` (4) more wait, each at
most `SPEECH_WAIT_SECONDS` (3); past that, or past the queue, it answers 503 and the next engine takes the recording,
so nothing waits behind a long one. A server that answers 500, or nothing within half a minute plus twice the
recording, counts as busy the same way. When the next engine fails too, the job retries as before.

**Optional, everywhere.** The service is on an internal network the app alone reaches, so the audio never leaves the
machine, and the image carries its models, pinned by revision and sha256 (`deploy/speech/models.txt`, credits in
`deploy/speech/NOTICE`). `deploy/deploy.sh` builds and starts it after the app is live and never waits for it, so a
speech image that doesn't build or a service that doesn't start never holds a deploy or a rollback; a build gets 15
minutes at most. Models that don't load leave the service up, unhealthy and answering 503, rather than restarting to
load the same files again on a machine it shares. A release whose speech image doesn't build publishes the app without
it. Self-hosted servers turn on the same profile, with the image each release publishes (SELF_HOSTING.md, Voice
messages).

## Addendum (2026-11-13): "gravando áudio…" for the others

**The decision.** People see when someone records a voice message, as they see typing: "Marina está gravando áudio…"
in the line above the composer, on the web and the phone. It rides the typing frame: `{"type":"typing", channelId,
threadId?, kind: "voice"}`, passed on as `user.typing` with the same `kind`, the same rate limit and the same 5 s
(`TYPING_TTL_MS`). No `kind` is typing, and any other reads as typing, so older apps keep working. The latest frame per
person wins. Agents never record.

**How long it lasts.** From the first second recorded until the message shows:

- The apps send it while the take records, held or hands free (web: `onRecording` from the kit's recorder each second;
  phone: `useVoiceTake`'s tick), never while starting or paused, and while the take uploads. The typing throttle keeps
  it to one frame every 3 s and sends a change of kind at once. The upload's frames (`keepAlive`) wait while the person
  has written in the last 3 s: writing takes over. The recorder's never wait, so a take started right after a typed
  message tells the agent asked in it at once.
- The upload's 202 hands it to the server: `voice.transcribe` sends it every 3 s while the words are made out
  (`keepRecording` in `voice.ts`), until the person's typing frame in that channel or the message. Its last frame is
  out before the message, which clears the line at once in the apps (`applyTypingEvent`). A message too big for its
  event still names its author (`authorUserId`), so a long take ends the line as fast.
- Paused or deleted, the frames stop: gone within 5 s. A recording dropped as silent, or one waiting for the job's
  retry, ends the same way.

**The look.** Three 3 px bars in the voice wave's look rise and fall where the dots are for typing, ink, never red,
still with reduced motion (`.ac-typing__bars`, the phone's `RecordingBars`). Who records comes last, as a group: the
bars, their faces, their words, agents' words first as always (`barWords`, `peopleGroups`). Beside someone typing,
each verb is a group with its own mark and faces ("Marina está digitando · Rui está gravando áudio…", `bothAtIt`), and
the second takes a line of its own when the line is short: names give way, verbs never. Copy:
`chat.activity.recordingVoice`.

**Agents wait for it.** A voice frame counts like typing (ADR 0112): a run started on a person's message holds its
first model call while they record a follow-up.

## Addendum (2026-11-15): typed text and files in the same message

**The need.** While a take existed, the recorder took the composer's place: nobody could type, paste or attach, and a
send carried the audio alone. A picture or a written line meant for the same message had to go as a second message.
Files attached before the take stayed on screen and were lost when it went.

**The decision.** One message carries the take, the text typed beside it and its files. The upload
(`POST …/channels/{channelId}/voice`) takes two optional fields: `text`, with a typed message's limit
(`message.too_long`), and `attachments`, a JSON array of file ids with a typed message's checks (this workspace's files
the sender uploaded or of this channel, at most 10: `message.attachment_not_found`, `message.too_many_attachments`).
Both are refused before anything is stored, and kept on `voice_clips` (`text`, `attachments`). `voice.transcribe`
posts `body` as the typed text, a blank line, then the words (the typed text alone when nothing was said), the files as
`meta.artifacts`, and the typed part again as `meta.voice.text`. A take with no words and nothing typed or attached is
still dropped; with either, the message goes.

**What reads what.** Agents get the body as before, typed part first, with no prompt change, so mentions, routing,
context and search see both. The apps show `meta.voice.text` as text above the player and the rest of the body as the
player's words (`voiceParts` in `@agenteschat/client`). Lists, notifications, push, thread titles and quotes show the
typed part (`readableBody`, `listedText`), and name the message a voice message only when nothing was typed: such a
message's preview carries no `voice` and no `mediaKind`, and its quote no `mediaKind`.

**Older apps.** The upload only gains optional fields, so an older app sends takes as before. An app that doesn't know
`meta.voice.text` shows the whole body in the player's transcript, typed text first: nothing is lost, only the typed
part isn't set apart. Its lists show the typed text, since the server sends them no voice marker for such a message.
A take with nothing said posts its audio with the typed text as its body, which an older app shows in the transcript.

**The composer.** A take is a row in the composer's file strip, above the text, the strip's whole width: play or the
red dot, the time, the wave, the keys line and delete at its end. The text field, attach, emoji, paste, drag and drop
and the pills stay usable during a take, and a take may start with files already attached. Its keys (Space listens,
Enter sends, Esc deletes) stay the recorder's except while the focus is in the field with text in it: there Enter sends
everything and Space types a space. Esc never drops both: with nothing typed it deletes the take as before; with text,
the take's row asks in place ("Delete the audio? Your text stays.", Delete, Keep, Enter keeps), never a dialog. The
keys line shows only while the keys are the take's. Uploads still running hold the send, as for a typed message. A
key an input method composes is never the take's. A pasted API key in the typed text stays in the box for the key
check while the take goes with the files.

**The phone.** The same model. Hands free or paused, the take's row (the time or play, the wave, pause, and delete at
its end) sits above the field in the field's own capsule, and the field and the "+" stay usable under it. The mic shows
whenever the field holds no words, also with files waiting, so a take can start with them. The field's send sends the
take, the words and the files as one message: the phone uploads its files at send time, so they upload first, and when
one fails the take stays, paused, with the words back in the field. The offline queue keeps the typed text and the
uploaded files with the recording and sends them with it. Holding the mic and sliding to cancel are unchanged. The
phone has no Esc question: delete in the row removes only the take, and the words stay in the field.

## Addendum (2026-11-17): the take on the phone, touch by touch

- **The first words are kept.** The recorder got ready only once the hold was reached, so about 0.3 s of speech was lost. Now the audio session and the recorder get ready as the finger lands on the microphone (`warm`). The take starts with its haptic, and the permission is read ahead, so a hold that is allowed waits on nothing. A press that never reaches the hold records nothing and gives the session back (`cool`).
- **The field is back as the take goes.** Letting go (or tapping send) puts the field back at once, with a light haptic, while the recorder closes behind it (`sending`). The message plays `send` (ADR 0070).
- **Throwing a take away.** On the way to the cancel line, the clock gives way to a red trash. Once the line is crossed, or the trash tapped, a medium haptic lands and the wave folds into the trash in `FOLD_MS`. The `discard` sound plays once the recorder has stopped. The toast is gone, and a screen reader still hears "Gravação apagada".
- **Each touch answers.** Locking is a light haptic, and "Travado" lands with a click. Pausing is a light haptic, unless the app paused it (a call, the background). Listening is a selection haptic. The last 15 s warn once. A take too short shakes the field, with a warning haptic and the same line as before.
- **Entrances and exits.** The take's parts come and go with the app's entrances (`apps/mobile/src/ui/entrances.ts`): the recording fades in over the field, and the hint, the line and the bar rise 6 points in `motion.base`. Exits use `motion.fast`. With Reduce Motion, none of these entrances, exits or folds play.

## Addendum (2026-11-22): the take's haptics on iOS, and its start sound

While the session records, iOS mutes haptics and system sounds unless the app allows them (`allowHapticsAndSystemSoundsDuringRecording`, false by default), and `expo-audio` never does, so none of the take's haptics reached the hand on an iPhone. A local module (`apps/mobile/modules/voice-session`) allows them whenever a voice takes the session to record (`voiceAudio(true)`) and again right before the recorder starts, since preparing it sets the session up anew. The hold now lands with the medium haptic and the `record` sound (ADR 0070), and the recorder starts after `START_SOUND_MS` (90 ms), so the take doesn't hold the sound. The recorder is ready by then, having got ready while the finger was down.
