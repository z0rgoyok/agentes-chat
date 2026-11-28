/**
 * Live files on the server (ADR 0196): spreadsheets, presentations and canvases people and agents edit together.
 * Who may open one is `liveFileAccess` (`artifacts.ts`); the documents a process holds are `createLiveDocs`.
 */
export { changeActorOf, originFor, originOfActor, personHides } from "./access";
export { askAgentAbout, cleanSelection, type LiveAskDeps, type LiveAskSelection } from "./ask";
export {
  type AssetSource,
  copyAssetFrom,
  getAsset,
  LIVE_ASSET_BYTES,
  LIVE_ASSET_MB,
  type LiveAsset,
  type LiveAssetFile,
  type LiveAssetOrigin,
  listAssets,
  MARK_PICTURE_BYTES,
  type PictureFile,
  putAsset,
  putMarkPicture,
  readPictureFile,
} from "./assets";
export type { PresencePeer } from "./awareness";
export {
  agentCheckpointDue,
  type CheckpointOptions,
  idleDecision,
  LIVE_CHECKPOINTS,
  writeCheckpoint,
} from "./checkpoints";
export {
  COMMENT_ON_FILE,
  type CommentToolDeps,
  createCommentToolSource,
  isMediaConversation,
  LOOK_AT_COMMENT,
  RESOLVE_COMMENT,
} from "./comment-tools";
export {
  admitFileAgents,
  conversationFileId,
  ensureFileConversation,
  type FileConversationMeta,
  type FileConversationRef,
  type FileConversationSummary,
  fileConversationBrief,
  fileConversationOf,
  fileConversationSummaries,
  fileOfConversation,
  fileReadersAmong,
  isPinned,
  type LiveRef,
  liveRefFor,
  liveRefLine,
  liveRefOf,
  markWords,
  openFileConversation,
} from "./conversation";
export { createLiveFile } from "./create";
export {
  createLiveDocs,
  INLINE_BYTES,
  LIVE_TIMING,
  type LiveConn,
  type LiveDeps,
  type LiveDocs,
  type LiveEditOptions,
  type LiveLog,
  type LiveSession,
  type LiveTiming,
} from "./docs";
export { DOCUMENT_TOOL_LIMITS, documentTools } from "./document-tools";
export { type FileFont, readFileFonts } from "./file-fonts";
export {
  AGENT_IMAGE_WAIT_MS,
  type AgentImageContext,
  type AgentImageInput,
  type ChatImageFile,
  type ChatImageInput,
  type ChatImagesView,
  createLiveImages,
  generateForAgent,
  generateInChat,
  IMAGE_CALL_TIMEOUT_MS,
  type ImageFailure,
  type ImageModelOption,
  type ImageRequestInput,
  type ImageRequestStatus,
  type ImageRequestView,
  imageFailureOf,
  imageModelsFor,
  imageRequestOf,
  LIVE_IMAGE_JOB,
  type LiveImageDeps,
  type LiveImages,
  liveImageJobHandlers,
  requestImages,
  retryImages,
  runImageRequest,
  waitForImageRequest,
} from "./images";
export {
  announceVersion,
  armIdleCheckpoint,
  checkpointWindow,
  compactLiveDoc,
  enqueueCompaction,
  idleCheckpoint,
  LIVE_CHECKPOINT_JOB,
  LIVE_COMPACT_JOB,
  LIVE_COMPACTION,
  type LiveJobDeps,
  liveJobHandlers,
} from "./jobs";
export { isMediaKind, isTalkKind, MEDIA_KINDS, type MediaKind, mediaOfType, type TalkKind, talkKindOf } from "./media";
export {
  exportLive,
  type LiveExportFormat,
  type OfficePreview,
  officeLiveExporter,
  officePreview,
  openAsLive,
  writeLiveExport,
} from "./office";
export {
  bringMadePicture,
  type MadePicture,
  PICTURE_CHOICE,
  PICTURE_LIMITS,
  pictureProblem,
} from "./pictures";
export {
  documentFromMarkdown,
  kindOfDoc,
  LIVE_SNAPSHOT_TYPE,
  type LiveContent,
  liveContentOf,
  liveExcerpt,
  liveProblems,
  newLiveDoc,
  overLimit,
  replaceLiveDoc,
  snapshotContent,
  versionDoc,
} from "./preview";
export { type ResolveActor, type ResolvedMark, resolveComment, resolvedOf } from "./resolve";
export { type LiveChangeActor, loadHeadDoc, loadHeadState, type StoredChange } from "./store";
export {
  type CleanSvg,
  looksLikeSvg,
  rasterPicture,
  SVG_LIMITS,
  SVG_TYPE,
  type SvgRasterizer,
  sanitizeSvg,
  setSvgRasterizer,
} from "./svg";
export { enableSvgRasterizer } from "./svg-raster";
export {
  carriesLiveFile,
  createLiveFileToolSource,
  LIVE_ACTIVITY,
  LIVE_TOOL_LIMITS,
  type LiveFileToolDeps,
} from "./tools";
export { fetchWebPicture, WEB_PICTURE_LIMITS, type WebPicture, type WebPictureDeps } from "./web-pictures";
