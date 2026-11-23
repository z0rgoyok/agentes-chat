# 0199. A live file's conversation is a chat thread of its own

- Status: Accepted (built)
- Date: 2026-11-17
- Extends: 0145 (a task's conversation is a chat thread of its own), 0196 (live files), 0157 (who sees a file), 0029
  (threads), 0071 (agent replies notify)
- Amends: 0196 §6 ("Ask an agent" posts in the file's own conversation)
- Code: engine `packages/engine/src/live/conversation.ts` (`ensureFileConversation`, `openFileConversation`,
  `admitFileAgents`, `fileConversationSummaries`, `fileConversationBrief`, `fileConversationOf`, `cleanSelection`,
  `liveRefFor`, `liveRefOf`, `liveRefLine`, `conversationFileId`), `task-access.ts` (`fileConversationReaderSql`,
  `conversationReaderSql`, `channelReaderSql` and `fileSeenSql` with `FILE_CONVERSATION_DEPTH`,
  `audienceOfConversation`), `channels.ts` (`requireChannelAccess`, `readableChannelIds`), `artifacts.ts`
  (`readsWhereItLives`, `personReadableChannels`, `agentReaches`, `withPersonFacts`), `messages.ts`
  (`postPersonMessage` with `liveRef`, `insertMessageWithRuns`, `unreachedAgents`, `unreachedPeople`, `messageView`),
  `notification-producers.ts` (`notifyMessage`, `inChannel`), `threads.ts` (`unreadFileConversations`), `context.ts`
  (`attachedLine`, the file's block), `issues.ts` (`conversationOf`), `live/ask.ts` (`askAgentAbout`),
  `live/tools.ts` (`openFile`, `carriesLiveFile`, `generate_image`), `jobs.ts`, `thread-assess.ts`,
  `routine-state.ts` (`personCanPost`), `approvals.ts`, `operator-lookups.ts`, `operator-people.ts`; server
  `routes/app/artifacts.ts` (`POST …/artifacts/{id}/conversation`, `conversation` on `Artifact`), `routes/app/chat.ts`
  (`liveRef` on a post), `routes/app/threads.ts` (`GET …/unread-files`), `routes/app/schemas.ts` (`LiveSelection`,
  `LiveRef`), `realtime/ws.ts`; client `api/types.ts` (`FileConversation`, `Message.liveRef`, `UnreadFile`),
  `api/client.ts` and `http-client.ts` (`artifacts.conversation`, `reads.unreadFiles`, the post's `liveRef`),
  `api/queries.ts` (`useFileConversation`, `useUnreadFiles`, `useFileUnread`, `applyIssueEvent`), `live/types.ts`
  (`fileConversationOf`, `LiveRefInput`, `messageLiveRef`), `lib/notifications.ts` (`openTarget`); migration
  `0300_live_files.sql`; tests `packages/engine/test/file-conversation.test.ts`,
  `apps/server/test/file-conversation.test.ts`

## Context

ADR 0196 put agents inside live files, but talking to one went through "Ask an agent": a box that sent one message
to wherever the file lived (a channel's timeline, a task's conversation, or the asker's DM with the agent when the
file was in the shared Drive). The talk about a file ended up scattered across conversations, out of sight of the
others in the file, and nothing showed under the file what had been said about it. People expect a file's page to
carry its own discussion, the way a task's dialog carries the task's conversation (ADR 0145), with the agent that
made the file there to be asked, and comments pinned on what they point at.

## Decision

### 1. Model: a channel of kind `file` per live file, and one thread in it

Each live file (every kind of `LIVE_ARTIFACT_KINDS`: spreadsheet, presentation, canvas, document) gets, on first
use, its own channel (`channels.kind = 'file'`, `visibility = 'private'`, named `file-<id>`, never listed) and one
root message in it (`meta.fileConversation = { artifactId, kind, title }`, by the file's maker, at the file's time).
The conversation is that thread's replies. `artifacts.conversation_channel_id` (unique, `on delete set null`) and
`artifacts.conversation_root_id` point at them. It is the task's model of ADR 0145 §1 for the same reasons: runs,
context, tools, approvals, live events, receipts and the thread screens work unchanged, and a new kind keeps it out
of every list that reads `kind = 'channel'` or `'dm'`.

`POST …/artifacts/{id}/conversation` makes it on first use and returns `{ channelId, rootId }`
(`openFileConversation`): 404 for a file the person doesn't read or one in the trash, 400 `artifact.no_conversation`
for a kind that has none.

### 2. Who reads it: whoever reads the file, checked every time

People are never members of a `file` channel. `requireChannelAccess`, `readableChannelIds`, the socket's
subscriptions, the files' rules (`readsWhereItLives`, `personReadableChannels`), `personCanPost`, the approvals a
person sees and `channelReaderSql` let a person in when they read the file (`fileConversationReaderSql`: the file is
not in the trash and `fileSeenSql` holds, so where it lives and its sharing, ADR 0157). Sharing the file with the
whole workspace opens its conversation to everyone at once; moving it to the trash closes it until it is restored.

The reading rules nest: a file made in a file's conversation lives in that `file` channel, so it is read by who reads
the first file, and its own conversation by the same people. SQL can't recurse through these helpers, so the
nesting has a depth (`FILE_CONVERSATION_DEPTH`, 1): a file in a file's conversation reads like that file; past it,
only the file's sharing or the shared Drive reaches it. `audienceOfConversation` (what an agent picks for what it
makes there) and a task made there (`conversationOf` in `issues.ts`) follow where the file lives, so a task made in
a private file's conversation stays private.

Agents are members, because a mention resolves among a channel's members. They join when they may work on the file
(`admitFileAgents`): the agent that made the file, when the conversation is made; and an agent named by a person's
or an agent's `@handle` there when the file is in the shared Drive, shared past its conversation (who mentioned it
reads it), or lives in a conversation the agent is in or a public channel. An agent named there that can't reach the
file doesn't join, so the mention reaches nobody. A run in the file's conversation reaches that file to change it
(`agentReaches`), as everyone in it watches.

Unlike a task's conversation (ADR 0145, addendum 2026-11-12), a file's has no agent of its own answering what names
nobody: people talk to each other there (comments, pins), and a message that names nobody goes to the router as in
a channel. "Pedir ao <agente>" in the apps writes "@handle " in the composer.

### 3. A message points at what was selected

A message there may carry `meta.liveRef = { artifactId, kind, title, selection? }`: the file and what its writer had
selected (`selection`: `label` as the apps word it, a sheet's id and A1 range, a slide's id, canvas shape ids, a
canvas comment's `point` in world units, a document's quoted `text` of at most 200 characters and its `block` id;
`cleanSelection` keeps only these, each cut to its size). The chat's post route takes `liveRef: { artifactId,
selection? }`, only for the conversation's own file (`message.live_ref` otherwise), and the server adds the kind and
the title. Messages show it as `liveRef` (from `messageView`). A canvas comment pin is such a message with a
`point`: no shape is stored for it, the canvas draws the conversation's messages that have one.

### 4. The agent's context and tools

A run in a file's conversation gets a block naming the file in focus, read from the artifact now (`fileConversationBrief`:
its kind, title and id, whether the agent made it, the tools that read and change it), and each message's `liveRef`
comes under it as a line (`liveRefLine`), the selection's label and quoted words as outside text (`untrustedBlock`).
The `files` tools load for every run there (`carriesLiveFile` with the run's channel), and `read_*`, `edit_*` with no
file named act on the conversation's file (`openFile`); `generate_image` with no canvas named puts its pictures on
the canvas whose conversation it is.

### 5. Notifications and unread

`notifyMessage` treats a `file` channel's messages as a thread's (ADR 0029), with `inChannel` reading whoever reads
the file: who it mentions gets a `mention`, the thread's followers (the file's maker, who wrote there, who followed
it) a `thread_reply`, the person behind an agent's run its `agent_reply`. Their source names the file
(`source.artifactId`, `label` its title) with the channel, the thread and the message, and the apps open the file
with its conversation at that message (`openTarget`: `/drive/<id>?m=<message>`). A person named there who reads the
file is in the message's `mentioned_user_ids` like a member.

`unreadFileConversations` (`GET …/unread-files`) counts, per file they read now, the replies after their
`thread_reads` mark: every one where they follow the conversation, else only those that mention them
(`useFileUnread` in the apps lights "Conversa", the mentions add the red count). Reading the thread clears them.

### 6. The file's page reads it in one query

`Artifact.conversation` (`withPersonFacts` → `fileConversationSummaries`, one statement for a page of the Drive):
`channelId`, `rootId`, `count` (replies, quiet notices left out), `lastAt`, `participants` (the first five to
write, oldest first) and `working` (a live run there); null until the conversation is first opened or written.
`GET …/artifacts/{id}` is what the file's page reads first, so it carries it too. It refreshes like the task's: the
page follows its conversation's channel while open (its message events), and a notice about the file
(`notification.upserted` with `source.artifactId`) reads the file's unread marks and its head again
(`applyIssueEvent`).

On the web the conversation docks beside the file from 1100 px wide (the page keeps its width, so it never covers
the file) and opens over the page below that, full screen on a phone. Its left edge is a handle (a separator with a
value: drag, ←/→, Home/End, a double click for the default) that sets its width between 340 px and the lesser of
720 px and half the window, kept per person and workspace. When the file itself would get less than 680 px beside it,
the app's sidebar folds to its rail (never stored as the person's choice) and comes back once 48 px more than that
fits with it open; once the person uses the sidebar's toggle on the page, the page leaves it to them.

### 7. "Ask an agent" goes to the file's conversation

`askAgentAbout` (`POST …/artifacts/{id}/live/ask`, kept for older apps) now posts in the file's conversation, naming
the agent, with the selection as `meta.liveRef` and no card of the file; when the agent can't work on the file there
(a private channel it isn't in) it still goes to the person's DM with the agent, carrying the file, as before.

### 8. Migration 0300

`0300_live_files.sql` adds `file` to `channel_kind` and the two columns of `artifacts` with their unique
index and foreign key. Nothing moves: conversations are made on first use.

### 9. On the phone

Every live file's screen ends with the conversation's line, in glass (`FileTalkLine`): the faces of who took part,
what an agent does there now in its color (its runs heard on the conversation's channel while the screen shows),
else the last message, the count and my unread mentions; it goes while the keyboard is up. A tap pushes the phone's
thread screen at the conversation's root, titled by the file's kind, with where the file was made at its top
(`FileOrigin`). "Ask Atlas" (a spreadsheet's or a slide's menu, a canvas picture's bar, a document's format
bar) opens it with "@handle " in the composer and the selection as the quote over it, sent as `meta.liveRef`; a
canvas comment is a tap with the comment tool, its pin drawn from the conversation's messages. A message's line about
a file goes back to the file under the conversation (or opens it) and shows that part. `/drive/<id>?m=` links and
notices open the file and push its conversation at that message. Code: `apps/mobile/src/features/live-files/talk/*`,
the live screens, `chat/ChatScreen.tsx` and `MessageRow.tsx`, `links/logic.ts`.

## Consequences

- A live file's conversation is chat: a mention there wakes the agent, which answers in that thread beside the file,
  with everything chat has.
- One more channel row and one root message per file someone talked about; nothing for the others.
- People are never members of a file's conversation: lists, unread counts and search that read membership don't
  show it, by design (as a task's, ADR 0145). Its messages are not in the person's search results yet.
- `requireChannelAccess` adds one `exists` for a `file` channel, and the reading rules grow by one nested level of
  the file rules (`FILE_CONVERSATION_DEPTH`).
- Consultations' hand-offs and the canceling of a consulted run stay a DM's and a task's (`answersHandOffs`,
  `cancel.ts`): the right hand hands work only to those.
