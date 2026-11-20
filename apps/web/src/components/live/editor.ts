import type { Artifact, LiveRoom, LiveSelection } from "@agenteschat/client";
import type { Peer } from "@agenteschat/live/awareness";

/**
 * The selection as words and as data (the client's type, `meta.liveRef.selection`): the words go over the file's
 * conversation's composer and on the message's line ("Custos!C2:D6", "Slide 3", "2 imagens"), the data to the agent.
 */
export type { LiveSelection };

/**
 * What the live file page hands every editor (ADR 0196): the spreadsheet, the presentation and the canvas each get
 * these props from `LiveFilePage` and draw everything below the page's header.
 */
export interface LiveEditorProps {
  /** The file's document, presence, undo and connection. */
  room: LiveRoom;
  orgId: string;
  /** The file as the Drive knows it: title, where it lives, who sees it. */
  artifact: Artifact;
  /** Nothing can be changed (the file is in the trash, its workspace is closing, or it is an older version). */
  readOnly: boolean;
  /** The person's language: formulas, number formats and dates are typed and shown in it. */
  locale: string;
  /** Where the page's address says to start (a sheet, a slide, presenting). */
  search: LiveEditorSearch;
  /** Keeps the address in step with the editor (replaces the history entry). */
  onSearch(patch: Partial<LiveEditorSearch>): void;
  /** The person this person follows: the editor moves its view along with theirs. Null: nobody. */
  following: Peer | null;
  /** The person moved the view themselves, or the one they follow left: stop following. */
  onStopFollowing(): void;
  /**
   * What is selected now (ADR 0199): it shows over the file's conversation's composer and rides on the next message
   * there (`meta.liveRef`). Null: nothing in particular (the whole file).
   */
  onSelection(selection: LiveSelection | null): void;
  /**
   * Asks in the file's conversation (ADR 0199): the conversation opens, its composer starts with the file's agent's @
   * and `text`, and the selection (the request's, else what is selected now) rides along. Absent: the page doesn't (a
   * saved version shown read-only). The same function `useAskInConversation()` gives.
   */
  onAsk?(request?: LiveAskRequest): void;
  /**
   * A message's line about part of this file was clicked (ADR 0199): select that part and bring it into view. A new
   * `key` for each click, so the same part shown twice moves there twice.
   */
  reveal?: LiveReveal | null;
  /**
   * The page's versions, for an editor that draws the file's meta line itself (a document's page, Wiki style, ADR
   * 0200): "edited now" opens them. Sharing is the header's "Share" alone.
   */
  onVersions?(): void;
}

/** The page's address parameters an editor reads and writes. */
export interface LiveEditorSearch {
  /** A spreadsheet's sheet id. */
  sheet?: string;
  /** A presentation's slide id. */
  slide?: string;
  /** The presentation opens presenting. */
  present?: boolean;
  /** A message of the file's conversation to open at (a link, a notice, a canvas's comment pin, ADR 0199). */
  m?: string;
}

/** "Pedir ao Atlas", "Variações" (ADR 0199): what goes to the file's conversation's composer. */
export interface LiveAskRequest {
  /** The agent whose @ starts the message; absent: the file's agent (`useFileAgent`); null: none (a comment). */
  agentId?: string | null;
  /** Words after the @ ("faz variações desta imagem"). */
  text?: string;
  /** What the message is about; absent: what is selected in the file now; null: the whole file. */
  selection?: LiveSelection | null;
}

/** Part of the file a message pointed at, to select and show (`LiveEditorProps.reveal`). */
export interface LiveReveal {
  selection: LiveSelection;
  key: number;
}
