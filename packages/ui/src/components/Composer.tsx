import { Popover as RPopover } from "radix-ui";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { channelQuery, insertChannelRef } from "../channel-refs";
import { cx } from "../cx";
import { composes, onScreenKeyboard } from "../device";
import { searchEmoji } from "../emoji-data";
import { EDGE_ROOM, placeOverSelection } from "../floating";
import {
  applyFormat,
  FORMAT_KINDS,
  type FormatKind,
  formatShortcut,
  formatShortcutHint,
  insertText,
  pasteLink,
  type TextEdit,
} from "../format";
import { useScrollSides } from "../hooks/useScrollSides";
import { Icon, type IconName } from "../icons/Icon";
import { selectionRect } from "../selection-rect";
import { dragsFiles, pastedFiles, transferFiles } from "../transfer";
import { typeInto } from "../type-into";
import { Button } from "./Button";
import { type EmojiPickerLabels, EmojiPickerPopover, type PickerTab } from "./EmojiPicker";
import { useAutoGrow, useLocked, useStillDefaultText } from "./Field";
import { modKey } from "./Kbd";
import { PixelStop } from "./PixelMarks";
import { Spinner } from "./Skeleton";
import { useVoiceRecorder, type VoiceNotice, type VoiceTake, voiceRecordingSupported } from "./voice-recorder";

/** Names of the formatting buttons (also their tooltips, with the shortcut). */
export type ComposerFormatLabels = Record<FormatKind, string> & {
  /** Accessible name of the toolbar ("Formatação"). */
  toolbar: string;
  /** Put in `[…](https://)` when making a link with nothing selected ("texto"). */
  linkText?: string;
};

const FORMAT_ICON: Record<FormatKind, IconName> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
  codeBlock: "codeBlock",
  link: "link",
  bulletList: "bulletList",
  numberedList: "numberedList",
  quote: "quote",
};
/** A hairline after these (inline styles | code | link | blocks). */
const FORMAT_GROUP_ENDS: FormatKind[] = ["strike", "codeBlock", "link"];

/** One "@" suggestion. `insert` is what goes after the "@" (the handle). */
export interface ComposerSuggestion {
  key: string;
  insert: string;
  label: string;
  /** "@ada · Agente · Dev". */
  description?: ReactNode;
  /** A small avatar. */
  leading?: ReactNode;
  /** "não está no canal". */
  note?: string;
  /** Consecutive items with the same group get a heading ("Neste canal", "No workspace"). */
  group?: string;
}

export interface ComposerMentions {
  /** Suggestions for what follows "@", already filtered and ordered. */
  search: (query: string) => ComposerSuggestion[];
  /** After an item was inserted (e.g. offer "Adicionar ao canal"). */
  onPick?: (item: ComposerSuggestion) => void;
  /** Accessible name of the list ("Pessoas e agentes"). */
  listLabel: string;
}

/** A "/" command: picking it runs `onPick` (or puts `insert` in the box). */
export interface ComposerCommand {
  key: string;
  /** "/relatório". */
  label: string;
  /** "Theo monta um documento". */
  description?: ReactNode;
  leading?: ReactNode;
  /** Text that replaces the box (e.g. "/relatório "). Defaults to `${label} `. */
  insert?: string;
  onPick?: () => void;
}

export interface ComposerCommands {
  list: ComposerCommand[];
  /** Accessible name of the menu ("Comandos"). */
  listLabel: string;
}

/** An agent is working here: with an empty box, send turns into stop (click or Esc stops right away). */
export interface ComposerWorking {
  /** "Parar o Theo". */
  stopLabel: string;
  /** The stop button's tooltip ("Parar o Theo · Esc"). */
  stopText?: ReactNode;
  onStop: () => void;
}

/**
 * Voice messages in the box: what it says, and what the app does with a recording (ADR 0100). A take is a row above
 * the text, which stays usable: sending it sends what was typed and attached too, in one message (`onTake` reads them
 * from the app's own draft and files).
 */
export interface ComposerVoice {
  /** Where this recording would go: when it changes, one under way is dropped. */
  scope: string;
  /**
   * Asked before the microphone opens: false stops there (the app says why). `"tap"`: the app asked the person first
   * (a dialog), so a press held meanwhile records hands free instead of ending with its release.
   */
  allowed?: () => Promise<boolean | "tap">;
  onTake: (take: VoiceTake) => void;
  onNotice: (notice: VoiceNotice) => void;
  /** Each second it records, never while starting or paused: the others see "gravando áudio…". */
  onRecording?: () => void;
  labels: {
    record: string;
    recording: string;
    pause: string;
    resume: string;
    discard: string;
    send: string;
    listen: string;
    stopListening: string;
    /** "Enter envia · Esc apaga". */
    keys: string;
    /** While holding the microphone. */
    keysHold: string;
    keysPaused: string;
    /** The last seconds, counting down: "faltam 13 s". */
    left: (seconds: number) => string;
    /** Esc with text in the box asks first, in the take's row: "Apagar o áudio? O texto fica." */
    askDiscard: string;
    askDelete: string;
    askKeep: string;
  };
}

/** The clock counts down over the last seconds of the five minutes. */
const VOICE_LIMIT_S = 300;
const VOICE_COUNTDOWN_S = 15;

/** The take's own buttons, which take its keys as they did when the take stood alone in the box. */
const TAKE_CONTROLS = ".ac-composer__voice-trash, .ac-composer__mic, .ac-composer__send, .ac-composer__listen";
/** Where a key is someone else's while there is a take: another field, a menu, a picker. */
const OTHER_KEYS = "input, textarea, select, [contenteditable], [role='dialog'], [role='menu'], [role='listbox']";

/** What takes its own click in the card; a click anywhere else in it belongs to the text box. */
const COMPOSER_CONTROLS = "button, a, input, select, textarea, label, canvas, [role='button'], [role='menuitem']";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Called with the trimmed text on Enter (Shift+Enter adds a line) or the send button. While `working`
   * or with `agentBusy`, `opts.interrupt` says whether the person sent it with ⌘/Ctrl+Enter (stop and send).
   */
  onSend: (text: string, opts?: { interrupt?: boolean }) => void;
  /** Accessible name of the text box, e.g. "Mensagem para #eng". */
  label: string;
  placeholder?: string;
  sendLabel: string;
  attachLabel?: string;
  onAttach?: () => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Lets the parent focus the box or insert text (e.g. "Chamar um agente"). */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  /** Esc in the box means something here (stopping an agent): a panel beside it doesn't close on it. */
  keepsEsc?: boolean;
  /** "@" autocomplete (combobox pattern on the text box). */
  mentions?: ComposerMentions;
  /** "/" at the start of the box opens these commands (same combobox). */
  commands?: ComposerCommands;
  /** `[[` autocompletes (e.g. wiki pages): `insert` is the title put inside `[[…]]`. */
  links?: ComposerMentions;
  /** "#" autocompletes channels: `insert` is the name put after the "#". */
  channels?: ComposerMentions;
  /** Context pills on a line above the text (the target agent, the active skill, a select of who answers). */
  pills?: ReactNode;
  /** The send button's tooltip, with the key hint ("Enviar ↵"). */
  sendText?: string;
  /** Formatting (bold, italic, lists…) in a bar that floats over selected text, and its ⌘/Ctrl shortcuts, writing Markdown. */
  format?: ComposerFormatLabels;
  /** The emoji button: the picker inserts at the caret. `button` names it ("Emoji"). */
  emoji?: EmojiPickerLabels & { button: string };
  /**
   * More tabs in the emoji button's picker, after Emojis (GIFs and stickers, ADR 0091): one picker with tabs, named
   * by `pickerLabels`. What a tab picks it sends itself.
   */
  pickerTabs?: PickerTab[];
  pickerLabels?: { dialog: string; tabs: string };
  /** Files picked with the attach button (when there is no `onAttach`), dropped on the box or pasted. */
  onFiles?: (files: File[]) => void;
  /** Inside the card, above the text (e.g. "Respondendo a Ana" with the quoted line). */
  header?: ReactNode;
  /** Inside the card, above the text's row (e.g. files being uploaded, as `ComposerFile`). */
  attachments?: ReactNode;
  /** Something is attached: the message may go without text. */
  canSendEmpty?: boolean;
  /** Not yet (e.g. uploads still running): Enter and the send button wait. */
  sendBlocked?: boolean;
  /**
   * Inside the card, above the text's row: why this text can't go and the way out (a draft past the length limit,
   * with "Enviar como arquivo"). Given together with `sendBlocked`.
   */
  notice?: ReactNode;
  /** An agent is working in this conversation (send ↔ stop). */
  working?: ComposerWorking | null;
  /**
   * An agent works here: Enter adds the message to what it is doing, ⌘/Ctrl+Enter stops it to read the message now.
   * Given on its own (without `working`) to whoever may write but not stop it: there is just no stop button.
   */
  agentBusy?: boolean;
  /** The microphone: absent, there is none. */
  voice?: ComposerVoice;
}

/**
 * A thumbnail's address: only a local object URL (`blob:`), the only kind the apps make for a picked file, through
 * `encodeURI` (which leaves such a URL as it is), so nothing from the file can reach the page as markup or as a
 * script address. Any other address shows the file's icon instead.
 */
const thumbnailSrc = (url: string | undefined) => (url?.startsWith("blob:") ? encodeURI(url) : undefined);

/**
 * A file in the composer, as a tile beside the others: an image shows its
 * thumbnail (`preview`, a local object URL); the rest show the type, name and
 * `detail` (the size). A spinner while it uploads, with a bar along its foot once the share sent is known, remove.
 */
export function ComposerFile({
  name,
  icon = "file",
  preview,
  detail,
  status,
  statusLabel,
  progress,
  removeLabel,
  onRemove,
}: {
  name: string;
  icon?: IconName;
  /** An image's thumbnail: a local object URL (`blob:`). */
  preview?: string;
  /** Under the name ("1,2 MB"). */
  detail?: string;
  status: "uploading" | "done" | "failed";
  /** Read with the name ("enviando…", "não enviado"). */
  statusLabel?: string;
  /** The share sent while it uploads, 0 to 1, when the app knows it. */
  progress?: number;
  /** "Remover relatorio.pdf". */
  removeLabel: string;
  onRemove: () => void;
}) {
  const remove = (
    <button type="button" className="ac-composer__file-remove" aria-label={removeLabel} onClick={onRemove}>
      <Icon name="close" size={14} />
    </button>
  );
  const pct =
    status === "uploading" && progress !== undefined ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;
  const bar = pct !== null && (
    <span
      className="ac-composer__file-progress"
      role="progressbar"
      aria-label={statusLabel ?? name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span style={{ width: `${pct}%` }} />
    </span>
  );
  const src = thumbnailSrc(preview);
  if (src) {
    return (
      <span
        className="ac-composer__file ac-composer__file--image"
        data-status={status}
        aria-busy={status === "uploading" || undefined}
        title={name}
      >
        <img src={src} alt="" />
        <span className="ac-visually-hidden">{name}</span>
        {status !== "done" && (
          <span className="ac-composer__file-state" aria-hidden="true">
            {status === "uploading" ? <Spinner size={16} /> : <Icon name="alert" size={16} />}
          </span>
        )}
        {statusLabel && <span className="ac-visually-hidden">{statusLabel}</span>}
        {bar}
        {remove}
      </span>
    );
  }
  return (
    <span className="ac-composer__file" data-status={status} aria-busy={status === "uploading" || undefined}>
      <span className="ac-composer__file-icon">
        {status === "uploading" ? (
          <Spinner size={16} />
        ) : (
          <Icon name={status === "failed" ? "alert" : icon} size={18} />
        )}
      </span>
      <span className="ac-composer__file-text">
        <span className="ac-composer__file-name" title={name}>
          {name}
        </span>
        {(statusLabel || detail) && <span className="ac-composer__file-detail">{statusLabel ?? detail}</span>}
      </span>
      {bar}
      {remove}
    </span>
  );
}

/**
 * The formatting buttons, floating over the text selected in the box (`range`, null while nothing is): inside the
 * composer's card and placed from it, so it goes where the card goes, right after the text box for the Tab key. One tab stop, arrows move between them (toolbar pattern). Not in the page until the first selection, kept
 * after it to fade out.
 */
function FormatBar({
  labels,
  onFormat,
  range,
  value,
  field,
  card,
  barRef,
  onLeave,
}: {
  labels: ComposerFormatLabels;
  onFormat: (kind: FormatKind) => void;
  range: [number, number] | null;
  /** The box's text: the bar moves as the words do. */
  value: string;
  field: RefObject<HTMLTextAreaElement | null>;
  card: RefObject<HTMLDivElement | null>;
  barRef: RefObject<HTMLDivElement | null>;
  /** The focus left the bar, or Escape was pressed in it (`back`: to the text box). */
  onLeave: (to: EventTarget | null, back?: boolean) => void;
}) {
  const [focus, setFocus] = useState(0);
  const used = useRef(false);
  const open = range !== null;
  if (open) used.current = true;
  const start = range?.[0] ?? 0;
  const end = range?.[1] ?? 0;
  const mod = modKey();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is why it runs again, the words under it moved
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = barRef.current;
      const text = field.current;
      const column = card.current?.getBoundingClientRect();
      const origin = el?.offsetParent?.getBoundingClientRect();
      if (!el || !text || !column || !origin) return;
      el.style.maxWidth = `min(${column.width}px, 100vw - ${2 * EDGE_ROOM}px)`;
      // Its layout size: the entrance's transform would measure it smaller.
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const to = placeOverSelection(selectionRect(text, start, end), size, column, window.innerWidth);
      el.style.left = `${to.left - origin.left}px`;
      el.style.top = `${to.top - origin.top}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, start, end, value, field, card, barRef]);
  if (!used.current) return null;
  const move = (i: number) => {
    const next = (i + FORMAT_KINDS.length) % FORMAT_KINDS.length;
    setFocus(next);
    barRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };
  return (
    <div
      ref={barRef}
      className="ac-formatbar"
      role="toolbar"
      aria-label={labels.toolbar}
      data-open={open || undefined}
      aria-hidden={!open || undefined}
      inert={!open}
      // Keep the text box's focus and selection, also on the room between the buttons.
      onMouseDown={(e) => e.preventDefault()}
      onBlur={(e) => onLeave(e.relatedTarget)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") move(focus + 1);
        else if (e.key === "ArrowLeft") move(focus - 1);
        else if (e.key === "Home") move(0);
        else if (e.key === "End") move(FORMAT_KINDS.length - 1);
        else if (e.key === "Escape") {
          e.stopPropagation();
          onLeave(null, true);
        } else return;
        e.preventDefault();
      }}
    >
      <FormatRow>
        {FORMAT_KINDS.map((kind, i) => {
          const hint = formatShortcutHint(kind, mod);
          return (
            <span
              key={kind}
              className="ac-formatbar__item"
              data-group-end={FORMAT_GROUP_ENDS.includes(kind) || undefined}
            >
              <button
                type="button"
                className="ac-formatbar__btn"
                aria-label={labels[kind]}
                title={hint ? `${labels[kind]} (${hint})` : labels[kind]}
                tabIndex={i === focus ? 0 : -1}
                onFocus={() => setFocus(i)}
                onClick={() => onFormat(kind)}
              >
                <Icon name={FORMAT_ICON[kind]} size={14} />
              </button>
            </span>
          );
        })}
      </FormatRow>
    </div>
  );
}

/**
 * The bar's one row of buttons, scrolling sideways with faded ends when the composer is narrower than it (a phone):
 * wrapped, its last row ended short of the bar's edge. Its own component so its scroller exists when the hook first
 * measures it: the bar renders nothing until the first selection.
 */
function FormatRow({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const more = useScrollSides(row);
  return (
    <div ref={row} className="ac-formatbar__row" data-more={more}>
      {children}
    </div>
  );
}

/** "[[que" right before the caret (no "]]" or line break yet). */
export function linkQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("[[");
  if (at < 0) return null;
  const query = before.slice(at + 2);
  if (/[\]\n[]/.test(query) || query.length > 80) return null;
  return { start: at, query };
}

/** "@que" right before the caret (start of text or after a space or bracket). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|[\s(])@([\p{L}\p{N}_-]{0,32})$/u);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** How many emoji a ":name" lists. */
const EMOJI_SUGGESTIONS = 8;

/**
 * ":nam" right before the caret, at the start or after a space (Slack, Discord): two letters at least, so a time
 * ("10:30") or a "Nota:" never opens the list.
 */
export function emojiQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|\s):([a-z][a-z0-9_+-]{1,31})$/i);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/**
 * The placeholder on one line, whatever the box's width (a phone, a task's side panel): the tip after its " · " goes
 * when all of it doesn't fit, and what's left ends in "…" (CSS) if even that doesn't. Measured, not guessed from the
 * window, because a focused field never ends it in "…" (the browser drops the ellipsis while editing).
 */
function useOneLinePlaceholder(ref: RefObject<HTMLTextAreaElement | null>, placeholder: string | undefined) {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !placeholder?.includes(" · ")) return;
    const pen = document.createElement("canvas").getContext("2d");
    if (!pen) return;
    let live = true;
    const measure = () => {
      // Hidden (a closed panel): it keeps the last answer.
      if (!live || !el.clientWidth) return;
      const s = getComputedStyle(el);
      pen.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      // A style not computed yet gives "" (NaN), which would read as no room at all.
      const room = el.clientWidth - (Number.parseFloat(s.paddingLeft) || 0) - (Number.parseFloat(s.paddingRight) || 0);
      setFits(pen.measureText(placeholder).width + 2 <= room);
    };
    measure();
    // The web font may land after the first measure, a little wider than the fallback.
    void document.fonts?.ready.then(measure);
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    watch?.observe(el);
    return () => {
      live = false;
      watch?.disconnect();
    };
  }, [ref, placeholder]);
  return fits ? placeholder : placeholder?.split(" · ")[0];
}

/**
 * Whether the box's text stays on one line (`oneLine`, its border-box height) at `width` px: the box itself is laid out
 * at that width and put back. A canvas can't stand in for it: it knows neither the app's font-size-adjust nor its font
 * features, so it measured the words narrower than the box draws them.
 */
function oneLineAt(el: HTMLTextAreaElement, width: number, oneLine: number): boolean {
  const { width: w, height: h, boxSizing: b } = el.style;
  el.style.boxSizing = "border-box";
  el.style.width = `${width}px`;
  el.style.height = "auto";
  const fits = el.scrollHeight + el.offsetHeight - el.clientHeight <= oneLine;
  el.style.boxSizing = b;
  el.style.width = w;
  el.style.height = h;
  return fits;
}

/**
 * More than one line: the text takes the card's whole width and the tools a row of their own under it (`data-wide`).
 * It goes back to one row only once the words fit beside the tools again, the box laid out at that narrower width, so
 * a line near the edge never flips the box back and forth. The text that made it wide, and any that only adds to it,
 * never sends it back: two answers that disagreed on one text would flip it on every render until React gave up.
 */
function useWideText(ref: RefObject<HTMLTextAreaElement | null>, value: string): boolean {
  const [wide, setWide] = useState(false);
  // The last text found not to fit beside the tools: added to (`fitText`'s `grows`), it can't fit either.
  const tooLong = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.closest<HTMLElement>(".ac-composer__row");
    if (!el || !row || !value) {
      tooLong.current = null;
      setWide(false);
      return;
    }
    if (value.includes("\n")) {
      setWide(true);
      return;
    }
    // A line's border-box height, with the same 2px of slack on both ways.
    const oneLine = (Number.parseFloat(getComputedStyle(el).minHeight) || 0) + 2;
    if (!wide) {
      // Wrapped: taller than its one line.
      if (el.offsetHeight > oneLine) {
        tooLong.current = value;
        setWide(true);
      }
      return;
    }
    if (tooLong.current !== null && value.startsWith(tooLong.current)) return;
    // More than a line across the whole card can't be one beside the tools.
    if (el.offsetHeight > oneLine) return;
    const tools = [...row.querySelectorAll<HTMLElement>(":scope > .ac-composer__tools")];
    if (oneLineAt(el, el.offsetWidth - tools.reduce((sum, t) => sum + t.offsetWidth, 0), oneLine)) setWide(false);
    else tooLong.current = value;
  }, [ref, value, wide]);
  return wide;
}

/**
 * The chat message box, one row: attach and emoji, the text, the microphone and send (primary, icon only). The row
 * grows with the text, its buttons staying at the bottom. Formatting floats over selected text. Focus on the whole box.
 */
export function Composer({
  value,
  onChange,
  onSend,
  label,
  placeholder,
  sendLabel,
  attachLabel,
  onAttach,
  disabled: off,
  id,
  className,
  textareaRef,
  keepsEsc,
  mentions,
  commands,
  links,
  channels,
  pills,
  sendText,
  format,
  emoji,
  pickerTabs,
  pickerLabels,
  onFiles,
  header,
  attachments,
  notice,
  canSendEmpty,
  sendBlocked,
  working,
  agentBusy,
  voice,
}: ComposerProps) {
  const locked = useLocked();
  const disabled = off || locked;
  const ref = useRef<HTMLTextAreaElement>(null);
  const shownPlaceholder = useOneLinePlaceholder(ref, placeholder);
  const wave = useRef<HTMLCanvasElement>(null);
  // The take's keys (Space, Enter, Esc) are the box's while the focus is in it with text there.
  const [inField, setInField] = useState(false);
  // Esc with text in the box: the take's row asks before deleting the audio.
  const [asking, setAsking] = useState(false);
  const keyOwner = useRef<(e: globalThis.KeyboardEvent) => boolean>(() => false);
  const rec = useVoiceRecorder(voice && { ...voice, onKey: (e) => keyOwner.current(e) }, wave);
  const recording = rec.active;
  if (asking && !recording) setAsking(false);
  const { discard } = rec;
  const scope = voice?.scope;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is why it runs
  useEffect(() => () => discard(false), [scope, discard]);
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  // The text selected in the box, while the box (or the formatting bar over it) has the focus.
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const notePicked = (start: number, end: number) =>
    setSelected((was) => (start === end ? null : was?.[0] === start && was[1] === end ? was : [start, end]));
  const listId = useId();
  useImperativeHandle(textareaRef, () => ref.current as HTMLTextAreaElement, []);
  useStillDefaultText(ref);
  // The "@…" being typed, and the one the person closed with Esc.
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  // `[[que` being typed (wiki links).
  const [linkToken, setLinkToken] = useState<{ start: number; query: string } | null>(null);
  // "#que" being typed (channels).
  const [channelToken, setChannelToken] = useState<{ start: number; query: string } | null>(null);
  // ":nam" being typed (emoji by name).
  const [emojiToken, setEmojiToken] = useState<{ start: number; query: string } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const caretAfter = useRef<number | null>(null);
  // A selection to restore after the text changes (formatting, an emoji).
  const selectAfter = useRef<[number, number] | null>(null);

  useAutoGrow(ref, value);
  const wide = useWideText(ref, value);
  // Once the text is in: the caret after an inserted mention, or a selection put back.
  useLayoutEffect(() => {
    // The box emptied without a keystroke (the message went out, a draft was cleared): no list stays open over it.
    if (!value) {
      setToken(null);
      setLinkToken(null);
      setChannelToken(null);
      setEmojiToken(null);
    }
    const el = ref.current;
    if (!el) return;
    if (caretAfter.current !== null) {
      el.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
    if (selectAfter.current) {
      el.focus();
      el.setSelectionRange(...selectAfter.current);
      selectAfter.current = null;
    }
  }, [value]);

  /** Every change the box makes itself (a pick, a format, an emoji) goes through here, so ⌘Z undoes it. */
  const put = (next: string) => {
    if (!ref.current || !typeInto(ref.current, next)) onChange(next);
  };
  /** Replaces the text and selection (formatting, emoji), keeping the focus in the box. */
  const edit = (next: TextEdit) => {
    const el = ref.current;
    notePicked(next.start, next.end);
    if (next.value === value) {
      el?.focus();
      el?.setSelectionRange(next.start, next.end);
      return;
    }
    selectAfter.current = [next.start, next.end];
    put(next.value);
  };
  const selection = () => {
    const el = ref.current;
    return { start: el?.selectionStart ?? value.length, end: el?.selectionEnd ?? value.length };
  };
  const applyKind = (kind: FormatKind) => {
    const { start, end } = selection();
    edit(applyFormat(value, start, end, kind, { link: format?.linkText }));
  };
  const insertEmoji = (e: string) => {
    const { start, end } = selection();
    edit(insertText(value, start, end, e));
  };
  const files = (list: FileList | null | undefined) => Array.from(list ?? []);
  const hasFiles = (e: DragEvent) => dragsFiles(e.dataTransfer);

  // "/" commands: only while the box is just "/word" (no space yet).
  const slash = commands ? /^\/(\S*)$/.exec(value) : null;
  const slashItems: ComposerSuggestion[] =
    slash && dismissed !== -1
      ? (commands?.list
          .filter((c) => c.label.toLowerCase().includes((slash[1] ?? "").toLowerCase()))
          .map((c) => ({
            key: c.key,
            insert: c.insert ?? `${c.label} `,
            label: c.label,
            description: c.description,
            leading: c.leading,
          })) ?? [])
      : [];
  const mentionItems = mentions && token && token.start !== dismissed ? mentions.search(token.query) : [];
  const linkItems = links && linkToken && linkToken.start !== dismissed ? links.search(linkToken.query) : [];
  const channelItems =
    channels && channelToken && channelToken.start !== dismissed ? channels.search(channelToken.query) : [];
  const emojiItems: ComposerSuggestion[] =
    emoji && !disabled && emojiToken && emojiToken.start !== dismissed
      ? searchEmoji(emojiToken.query.replace(/_/g, " "))
          .slice(0, EMOJI_SUGGESTIONS)
          .map((e) => ({
            key: e.emoji,
            insert: e.emoji,
            label: `:${e.name.replace(/ /g, "_")}:`,
            leading: <span className="ac-suggest__emoji">{e.emoji}</span>,
          }))
      : [];
  const items =
    slashItems.length > 0
      ? slashItems
      : linkItems.length > 0
        ? linkItems
        : channelItems.length > 0
          ? channelItems
          : emojiItems.length > 0
            ? emojiItems
            : mentionItems;
  const isSlash = slashItems.length > 0;
  const isLink = !isSlash && linkItems.length > 0;
  const isChannel = !isSlash && !isLink && channelItems.length > 0;
  const isEmoji = !isSlash && !isLink && !isChannel && emojiItems.length > 0;
  const open = items.length > 0;
  const current = Math.min(active, Math.max(0, items.length - 1));

  const track = (text: string, caret: number) => {
    if (links) {
      const nextLink = linkQuery(text, caret);
      if (nextLink?.start !== linkToken?.start || nextLink?.query !== linkToken?.query) {
        setLinkToken(nextLink);
        setActive(0);
      }
    }
    const nextChannel = channels ? channelQuery(text, caret) : null;
    if (channels && (nextChannel?.start !== channelToken?.start || nextChannel?.query !== channelToken?.query)) {
      setChannelToken(nextChannel);
      setActive(0);
    }
    const nextEmoji = emoji ? emojiQuery(text, caret) : null;
    if (emoji && (nextEmoji?.start !== emojiToken?.start || nextEmoji?.query !== emojiToken?.query)) {
      setEmojiToken(nextEmoji);
      setActive(0);
    }
    const next = mentions ? mentionQuery(text, caret) : null;
    if (mentions && (next?.start !== token?.start || next?.query !== token?.query)) {
      setToken(next);
      setActive(0);
    }
    // A closed "@", "#" or ":" list stays closed while its token is still being typed.
    if (
      dismissed !== null &&
      dismissed !== -1 &&
      next?.start !== dismissed &&
      nextChannel?.start !== dismissed &&
      nextEmoji?.start !== dismissed
    )
      setDismissed(null);
  };

  const pick = (item: ComposerSuggestion) => {
    if (isSlash) {
      const command = commands?.list.find((c) => c.key === item.key);
      caretAfter.current = item.insert.length;
      put(item.insert);
      command?.onPick?.();
      return;
    }
    if (isLink && linkToken) {
      const end = linkToken.start + 2 + linkToken.query.length;
      const inserted = `[[${item.insert}]] `;
      const next = value.slice(0, linkToken.start) + inserted + value.slice(end).replace(/^\]\]\s?/, "");
      caretAfter.current = linkToken.start + inserted.length;
      setLinkToken(null);
      put(next);
      links?.onPick?.(item);
      return;
    }
    if (isChannel && channelToken) {
      const next = insertChannelRef(value, channelToken, item.insert);
      caretAfter.current = next.caret;
      setChannelToken(null);
      put(next.text);
      channels?.onPick?.(item);
      return;
    }
    if (isEmoji && emojiToken) {
      const end = emojiToken.start + 1 + emojiToken.query.length;
      const rest = value.slice(end);
      const inserted = /^\s/.test(rest) ? item.insert : `${item.insert} `;
      caretAfter.current = emojiToken.start + inserted.length + (inserted === item.insert ? 1 : 0);
      setEmojiToken(null);
      put(value.slice(0, emojiToken.start) + inserted + rest);
      return;
    }
    if (!token) return;
    const caret = token.start + 1 + token.query.length;
    const inserted = `@${item.insert} `;
    const next = value.slice(0, token.start) + inserted + value.slice(caret).replace(/^ /, "");
    caretAfter.current = token.start + inserted.length;
    setToken(null);
    put(next);
    mentions?.onPick?.(item);
  };

  const ready = Boolean(value.trim() || canSendEmpty) && !disabled && !sendBlocked;
  const takeReady = recording && !sendBlocked;
  // An agent at work and nothing to send: the send button is the stop button.
  const stopMode = Boolean(working) && !disabled && !value.trim() && !canSendEmpty && !recording;
  const [pressed, setPressed] = useState(false);
  // The press flash; cleared if the composer goes away first (a stop that ends the run unmounts it).
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(pressTimer.current ?? undefined), []);
  const press = () => {
    setPressed(true);
    clearTimeout(pressTimer.current ?? undefined);
    pressTimer.current = setTimeout(() => setPressed(false), 160);
  };
  const stop = () => {
    if (!working) return;
    press();
    working.onStop();
  };
  const send = (alt = false) => {
    if (recording) {
      if (!sendBlocked) void rec.send();
      return;
    }
    if (!ready) return;
    if (working || agentBusy) onSend(value.trim(), { interrupt: Boolean(agentBusy) && alt });
    else onSend(value.trim());
    // Keep typing: focus stays in the box (also after clicking the send button).
    ref.current?.focus();
  };

  const dismiss = () =>
    setDismissed(
      isSlash
        ? -1
        : isLink
          ? (linkToken?.start ?? null)
          : isChannel
            ? (channelToken?.start ?? null)
            : isEmoji
              ? (emojiToken?.start ?? null)
              : (token?.start ?? null),
    );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Choosing and confirming a word in an input method takes Enter, Tab, Esc and the arrows: none is the box's.
    if (composes(e.nativeEvent)) return;
    // A layer above already closed on this Esc: the suggestions, or a card that opened under the pointer and left the
    // focus here. It is spent: it stops no agent, and the page's own Esc (an inbox reply closes on it) never sees it.
    if (e.key === "Escape" && e.defaultPrevented) {
      e.stopPropagation();
      return;
    }
    const kind = format ? formatShortcut(e) : null;
    // ⌘K links the selected words; with none selected it opens the command palette, as everywhere else.
    if (kind && !(kind === "link" && e.currentTarget.selectionStart === e.currentTarget.selectionEnd)) {
      e.preventDefault();
      e.stopPropagation();
      applyKind(kind);
      return;
    }
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + items.length) % items.length);
        return;
      }
      const item = items[current];
      // The first Enter picks, even on a name typed in full ("oi @ada"): people press it to choose, and a message
      // holding only the name went out by mistake. With the list closed by the pick, the next Enter sends.
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        if (item) pick(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        return;
      }
    }
    // Esc with a take and text here: the take's row asks first (an empty box's Esc is the recorder's: it deletes).
    if (e.key === "Escape" && recording) {
      e.preventDefault();
      e.stopPropagation();
      setAsking(true);
      return;
    }
    // Esc in an empty box while an agent works: stop it right away.
    if (e.key === "Escape" && stopMode) {
      e.preventDefault();
      e.stopPropagation();
      stop();
      return;
    }
    // On-screen keyboards: Enter is a new line; the send button sends.
    if (e.key === "Enter" && !e.shiftKey && !onScreenKeyboard()) {
      e.preventDefault();
      send(e.metaKey || e.ctrlKey);
    }
  };

  const typed = Boolean(value.trim());
  const keepTake = () => {
    setAsking(false);
    ref.current?.focus();
  };
  keyOwner.current = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (asking) {
      if (e.key === "Escape" || (e.key === "Enter" && !target?.closest(".ac-composer__voice-ask button"))) {
        e.preventDefault();
        e.stopPropagation();
        keepTake();
      }
      return true;
    }
    // Delete's own Enter deletes: from it, the take's Enter would send what the person meant to throw away.
    if (target?.closest(".ac-composer__voice-trash") && e.key !== "Escape") return true;
    if (target === ref.current) {
      // The box's own Esc asks first; its Enter sends everything; its Space types.
      if (typed) return true;
    } else if (target && box.current?.contains(target) && target.closest("button, a") && !target.closest(TAKE_CONTROLS))
      return true;
    else {
      const layer = target?.closest(OTHER_KEYS);
      if (layer && !layer.contains(box.current)) return true;
    }
    if (e.key === "Escape" && typed) {
      e.preventDefault();
      e.stopPropagation();
      setAsking(true);
      return true;
    }
    if (e.key === "Enter" && sendBlocked) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  };
  const hasMic = Boolean(voice) && !disabled && voiceRecordingSupported();
  const countdown = VOICE_LIMIT_S - rec.seconds;
  const counting = recording && countdown <= VOICE_COUNTDOWN_S;
  const voiceHint = !voice
    ? ""
    : counting
      ? voice.labels.left(countdown)
      : rec.phase === "paused"
        ? voice.labels.keysPaused
        : rec.hold
          ? voice.labels.keysHold
          : voice.labels.keys;
  const micLabel = !voice
    ? ""
    : rec.phase === "paused"
      ? voice.labels.resume
      : rec.phase === "rec" && !rec.hold
        ? voice.labels.pause
        : voice.labels.record;

  /** The take, as a row above the text: play or the red dot, the time, the wave, the keys, delete. */
  const take = (voice: ComposerVoice) =>
    asking ? (
      // biome-ignore lint/a11y/useSemanticElements: a question and its two answers, named as one
      <div className="ac-composer__voice-ask ac-actline" role="group" aria-label={voice.labels.recording}>
        <span aria-live="polite">{voice.labels.askDiscard}</span>
        <span className="ac-acts">
          <Button
            variant="ghost"
            size="sm"
            className="ac-composer__voice-trash"
            onClick={() => {
              rec.discard(true);
              ref.current?.focus();
            }}
          >
            {voice.labels.askDelete}
          </Button>
          <Button size="sm" onClick={keepTake}>
            {voice.labels.askKeep}
          </Button>
        </span>
      </div>
    ) : (
      // biome-ignore lint/a11y/useSemanticElements: a recording's controls, named as one
      <div className="ac-composer__voice" role="group" aria-label={voice.labels.recording}>
        {rec.phase === "paused" ? (
          <button
            type="button"
            className="ac-voice__play ac-composer__listen"
            aria-label={rec.listening ? voice.labels.stopListening : voice.labels.listen}
            onClick={() => void rec.toggleListening()}
          >
            <Icon name={rec.listening ? "pause" : "play"} size={14} />
          </button>
        ) : (
          <span className="ac-composer__voice-dot" aria-hidden="true" />
        )}
        <span ref={rec.timer} className="ac-composer__voice-time">
          0:00
        </span>
        <canvas ref={wave} className="ac-composer__wave" onPointerDown={rec.onWavePointerDown} />
        {(counting || !(inField && typed)) && (
          <span className="ac-composer__voice-hint" data-left={counting || undefined} aria-live="off">
            {voiceHint}
          </span>
        )}
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          icon="trash"
          className="ac-composer__voice-trash"
          aria-label={voice.labels.discard}
          onClick={() => rec.discard(true)}
        />
      </div>
    );

  const optionId = (i: number) => `${listId}-${i}`;
  const textarea = (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      aria-label={label}
      data-esc-own={keepsEsc ? "" : undefined}
      placeholder={shownPlaceholder}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (dismissed === -1 && !e.target.value.startsWith("/")) setDismissed(null);
        onChange(e.target.value);
        track(e.target.value, e.target.selectionStart ?? e.target.value.length);
        notePicked(e.target.selectionStart ?? 0, e.target.selectionEnd ?? 0);
      }}
      onSelect={(e) => {
        track(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
        notePicked(e.currentTarget.selectionStart ?? 0, e.currentTarget.selectionEnd ?? 0);
      }}
      onFocus={(e) => {
        setInField(true);
        notePicked(e.currentTarget.selectionStart ?? 0, e.currentTarget.selectionEnd ?? 0);
      }}
      // To the formatting bar (the Tab key): the selection is still what it formats.
      onBlur={(e) => {
        setInField(false);
        if (!(e.relatedTarget instanceof Node && bar.current?.contains(e.relatedTarget))) setSelected(null);
      }}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        const pasted = onFiles ? pastedFiles(e.clipboardData) : [];
        if (onFiles && pasted.length > 0) {
          e.preventDefault();
          onFiles(pasted);
          return;
        }
        if (!format) return;
        const { start, end } = selection();
        const linked = pasteLink(value, start, end, e.clipboardData?.getData("text/plain") ?? "");
        if (!linked) return;
        e.preventDefault();
        caretAfter.current = linked.start;
        put(linked.value);
      }}
      // A box with only the ":" list keeps its textbox role: that list is a shortcut beside the emoji button.
      {...(mentions || commands || links || channels
        ? {
            role: "combobox",
            "aria-autocomplete": "list" as const,
            "aria-expanded": open,
            "aria-controls": open ? listId : undefined,
            "aria-activedescendant": open ? optionId(current) : undefined,
          }
        : {})}
    />
  );

  const sendTitle = stopMode
    ? typeof working?.stopText === "string"
      ? working.stopText
      : working?.stopLabel
    : sendText
      ? `${sendText} ↵`
      : undefined;

  return (
    <RPopover.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && open) dismiss();
      }}
    >
      <RPopover.Anchor asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: files dropped anywhere on the card (the attach button is the accessible way), and its empty room is part of the text box, as a mouse sees it */}
        <div
          ref={box}
          className={cx("ac-composer", className)}
          data-wide={wide || undefined}
          data-disabled={disabled || undefined}
          data-dragging={dragging || undefined}
          data-voice={recording ? rec.phase : undefined}
          data-esc-layer={recording || attachments ? "" : undefined}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest(COMPOSER_CONTROLS)) return;
            // Keeps the caret where it was.
            e.preventDefault();
            ref.current?.focus();
          }}
          onDragOver={
            onFiles
              ? (e) => {
                  if (!hasFiles(e) || disabled) return;
                  e.preventDefault();
                  setDragging(true);
                }
              : undefined
          }
          onDragLeave={
            onFiles
              ? (e) => {
                  if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)))
                    setDragging(false);
                }
              : undefined
          }
          onDrop={
            onFiles
              ? (e) => {
                  setDragging(false);
                  if (!hasFiles(e)) return;
                  // Taken even when it can't be used: left alone, the browser opens the file in place of the app.
                  e.preventDefault();
                  const dropped = transferFiles(e.dataTransfer);
                  if (dropped.length > 0 && !disabled) onFiles(dropped);
                }
              : undefined
          }
        >
          {header && <div className="ac-composer__header">{header}</div>}
          {pills && <div className="ac-composer__pills">{pills}</div>}
          {(attachments || (voice && recording)) && (
            <div className="ac-composer__attachments">
              {voice && recording && take(voice)}
              {attachments}
            </div>
          )}
          {notice && (
            <div className="ac-composer__notice" role="alert">
              {notice}
            </div>
          )}
          <div className="ac-composer__row">
            <div className="ac-composer__tools">
              {attachLabel && (
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  icon="attach"
                  aria-label={attachLabel}
                  onClick={onAttach ?? (onFiles ? () => fileInput.current?.click() : undefined)}
                  disabled={(!onAttach && !onFiles) || disabled}
                />
              )}
              {onFiles && !onAttach && (
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  tabIndex={-1}
                  aria-label={attachLabel}
                  onChange={(e) => {
                    const picked = files(e.target.files);
                    e.target.value = "";
                    if (picked.length > 0) onFiles(picked);
                  }}
                />
              )}
              {emoji && !disabled && (
                <EmojiPickerPopover
                  labels={emoji}
                  onPick={insertEmoji}
                  tabs={pickerTabs}
                  tabLabels={pickerLabels}
                  align="start"
                  // Back to the text box (the caret after the emoji), not to the button.
                  onCloseAutoFocus={(e) => {
                    e.preventDefault();
                    ref.current?.focus();
                  }}
                  trigger={<Button variant="ghost" iconOnly size="sm" icon="smile" aria-label={emoji.button} />}
                />
              )}
            </div>
            <div className="ac-composer__text">
              {textarea}
              {format && !disabled && (
                <FormatBar
                  labels={format}
                  onFormat={applyKind}
                  range={open ? null : selected}
                  value={value}
                  field={ref}
                  card={box}
                  barRef={bar}
                  onLeave={(to, back) => {
                    if (back) ref.current?.focus();
                    else if (to !== ref.current && !(to instanceof Node && bar.current?.contains(to)))
                      setSelected(null);
                  }}
                />
              )}
            </div>
            <div className="ac-composer__tools">
              {hasMic && (
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  icon={rec.phase === "rec" && !rec.hold ? "pause" : "mic"}
                  className="ac-composer__mic"
                  data-on={rec.phase === "rec" || rec.phase === "paused" || undefined}
                  aria-label={micLabel}
                  title={micLabel}
                  {...rec.micProps}
                />
              )}
              {/* The compact primary square (32px): dim until there is something to send. */}
              {working !== undefined ? (
                // An agent may work here: one button whose glyph morphs between send and stop.
                <Button
                  variant="primary"
                  size="sm"
                  className="ac-composer__send ac-btn--icon"
                  data-ready={ready || stopMode || takeReady ? "" : undefined}
                  data-mode={stopMode ? "stop" : "send"}
                  data-press={pressed || undefined}
                  aria-label={recording && voice ? voice.labels.send : stopMode ? working?.stopLabel : sendLabel}
                  title={sendTitle}
                  onClick={() => {
                    if (stopMode) stop();
                    else {
                      press();
                      send();
                    }
                  }}
                  disabled={!ready && !stopMode && !takeReady}
                >
                  <span className="ac-composer__glyph ac-composer__glyph--send" aria-hidden="true">
                    <Icon name="send" />
                  </span>
                  <span className="ac-composer__glyph ac-composer__glyph--stop" aria-hidden="true">
                    <PixelStop size={13} animated={stopMode} />
                  </span>
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  iconOnly
                  icon="send"
                  className="ac-composer__send"
                  data-ready={ready || takeReady ? "" : undefined}
                  aria-label={recording && voice ? voice.labels.send : sendLabel}
                  title={sendTitle}
                  onClick={() => send()}
                  disabled={!ready && !takeReady}
                />
              )}
            </div>
          </div>
        </div>
      </RPopover.Anchor>
      {(mentions || commands || links || channels || emoji) && (
        <RPopover.Portal>
          <RPopover.Content
            className={cx("ac-menu ac-suggest", isSlash && "ac-suggest--commands")}
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={EDGE_ROOM}
            // Focus stays in the text box (combobox).
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              if (e.target instanceof Node && box.current?.contains(e.target)) e.preventDefault();
            }}
          >
            <div
              role="listbox"
              id={listId}
              aria-label={
                isSlash
                  ? (commands?.listLabel ?? "")
                  : isLink
                    ? (links?.listLabel ?? "")
                    : isChannel
                      ? (channels?.listLabel ?? "")
                      : isEmoji
                        ? (emoji?.dialog ?? "")
                        : (mentions?.listLabel ?? "")
              }
            >
              {items.map((item, i) => {
                const heading = item.group && item.group !== items[i - 1]?.group;
                return (
                  <div key={item.key} role="presentation">
                    {heading && (
                      <div className="ac-menu__heading" role="presentation">
                        {item.group}
                      </div>
                    )}
                    <div
                      id={optionId(i)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === current}
                      data-active={i === current || undefined}
                      className="ac-menu__item ac-suggest__item"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        pick(item);
                      }}
                      onClick={() => pick(item)}
                      onKeyDown={() => {}}
                    >
                      {item.leading && (
                        <span className="ac-menu__leading" aria-hidden="true">
                          {item.leading}
                        </span>
                      )}
                      <span className="ac-menu__label">
                        <span>{item.label}</span>
                        {item.description && <span className="ac-menu__desc">{item.description}</span>}
                      </span>
                      {item.note && <span className="ac-suggest__note">{item.note}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </RPopover.Content>
        </RPopover.Portal>
      )}
    </RPopover.Root>
  );
}
