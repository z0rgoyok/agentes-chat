/**
 * Live files in the apps (ADR 0196, 0197, 0198), the same on the web, the desktop app and the phone:
 *
 * - `useLiveRoom(orgId, fileId, { socketFactory, baseUrl, me, textFrames? })` opens a file (its state over HTTP, then
 *   its socket) as a `LiveRoom`, shared by every screen that shows it (`acquireLiveRoom`). Editors read `room.doc`
 *   with `@agenteschat/live` and write in `room.doc.transact(fn, LOCAL)`, which `room.undo` takes back; presence goes
 *   with `room.setLocal(...)` and comes with `useLivePeers(room)`; `useLiveDocVersion` and `useLiveSelector` redraw
 *   from the document. The web calls `room.checkAlive()` when the page shows again or the network comes back; the
 *   phone passes `textFrames`, pauses in the background (`room.pause()`, `room.resume()`) and keeps unsent changes
 *   across restarts (`room.unsentUpdate()`, `room.restoreUnsent(update)`).
 * - `api.live` (`LiveApi`) and the query hooks around it: making a file, versions, who is in which file, pictures,
 *   asking an agent, image models and requests, Office previews; `applyLiveEvent` hears `live.presence`.
 * - Tests: `@agenteschat/client/live/testing` serves files in memory over the same protocol (`FakeLiveServer`).
 */
export * from "./api";
export * from "./connection";
export * from "./events";
export * from "./hooks";
export * from "./queries";
export * from "./room";
export * from "./rooms";
export * from "./signals";
export * from "./types";
