import type { SFSymbolIcon } from "expo-router/native-tabs";
import type { IconName } from "./icons.data";

/** An SF Symbol name (iOS draws it: the bar buttons, the tab bar, `Icon`). */
export type SFSymbolName = Extract<NonNullable<SFSymbolIcon["sf"]>, string>;

/**
 * The system's symbol for each of our line icons on iOS: `sf` beside text and in buttons, `fill` on a colored tile
 * (white, as the system's Settings draw theirs). Null where the system has no such drawing (our agent, the waiting
 * fuse, the read checks, a sticker, the computers' own marks): those keep our line icon on every platform.
 * Pure data: `Icon` reads it, a test checks every icon has an entry.
 */
export const SF_SYMBOLS: Record<IconName, { sf: SFSymbolName; fill?: SFSymbolName } | null> = {
  home: { sf: "house", fill: "house.fill" },
  chat: { sf: "bubble.left", fill: "bubble.left.fill" },
  agent: null,
  bell: { sf: "bell", fill: "bell.fill" },
  search: { sf: "magnifyingglass" },
  plus: { sf: "plus" },
  send: { sf: "arrow.up" },
  back: { sf: "chevron.left" },
  more: { sf: "ellipsis" },
  check: { sf: "checkmark" },
  checks: null,
  x: { sf: "xmark" },
  clock: { sf: "clock", fill: "clock.fill" },
  wait: null,
  shield: { sf: "checkmark.shield", fill: "checkmark.shield.fill" },
  hash: { sf: "number" },
  chev: { sf: "chevron.down" },
  right: { sf: "chevron.right" },
  left: { sf: "chevron.left" },
  image: { sf: "photo", fill: "photo.fill" },
  file: { sf: "doc", fill: "doc.fill" },
  camera: { sf: "camera", fill: "camera.fill" },
  mic: { sf: "mic", fill: "mic.fill" },
  sound: { sf: "speaker.wave.2", fill: "speaker.wave.2.fill" },
  target: { sf: "scope" },
  list: { sf: "list.bullet" },
  reply: { sf: "text.bubble", fill: "text.bubble.fill" },
  copy: { sf: "doc.on.doc", fill: "doc.on.doc.fill" },
  link: { sf: "link" },
  expand: { sf: "arrow.up.left.and.arrow.down.right" },
  pin: { sf: "pin", fill: "pin.fill" },
  eyeoff: { sf: "eye.slash", fill: "eye.slash.fill" },
  moon: { sf: "moon", fill: "moon.fill" },
  sun: { sf: "sun.max", fill: "sun.max.fill" },
  cloud: { sf: "cloud", fill: "cloud.fill" },
  globe: { sf: "globe" },
  out: { sf: "rectangle.portrait.and.arrow.right", fill: "rectangle.portrait.and.arrow.right.fill" },
  code: { sf: "chevron.left.forwardslash.chevron.right" },
  bold: { sf: "bold" },
  italic: { sf: "italic" },
  strike: { sf: "strikethrough" },
  codeBlock: { sf: "curlybraces" },
  bulletList: { sf: "list.bullet" },
  numberedList: { sf: "list.number" },
  quote: { sf: "text.quote" },
  server: { sf: "server.rack" },
  mail: { sf: "envelope", fill: "envelope.fill" },
  chart: { sf: "chart.bar", fill: "chart.bar.fill" },
  pen: { sf: "pencil" },
  doc: { sf: "doc.text", fill: "doc.text.fill" },
  sparkle: { sf: "sparkles" },
  smile: { sf: "face.smiling", fill: "face.smiling.inverse" },
  sticker: null,
  laptop: { sf: "laptopcomputer" },
  phone: { sf: "iphone" },
  computerMac: null,
  computerWindows: null,
  computerLinux: null,
  archive: { sf: "archivebox", fill: "archivebox.fill" },
  circle: { sf: "circle", fill: "circle.fill" },
  pause: { sf: "pause", fill: "pause.fill" },
  lock: { sf: "lock", fill: "lock.fill" },
  key: { sf: "key", fill: "key.fill" },
  keyboard: { sf: "keyboard", fill: "keyboard.fill" },
  stop: { sf: "stop", fill: "stop.fill" },
  flag: { sf: "flag", fill: "flag.fill" },
  help: { sf: "questionmark.circle", fill: "questionmark.circle.fill" },
  info: { sf: "info.circle", fill: "info.circle.fill" },
  compose: { sf: "square.and.pencil" },
  checkc: { sf: "checkmark.circle", fill: "checkmark.circle.fill" },
  share: { sf: "square.and.arrow.up", fill: "square.and.arrow.up.fill" },
  photos: { sf: "photo.on.rectangle", fill: "photo.fill.on.rectangle.fill" },
  drive: { sf: "folder", fill: "folder.fill" },
  undo: { sf: "arrow.uturn.backward" },
  issue: { sf: "smallcircle.filled.circle", fill: "smallcircle.filled.circle.fill" },
  gitPull: { sf: "arrow.triangle.pull" },
  brain: { sf: "brain", fill: "brain.fill" },
  bolt: { sf: "bolt", fill: "bolt.fill" },
  join: { sf: "arrow.right.to.line" },
  play: { sf: "play", fill: "play.fill" },
  replay: { sf: "arrow.counterclockwise" },
  mute: { sf: "speaker.slash", fill: "speaker.slash.fill" },
  fullscreen: { sf: "arrow.up.left.and.arrow.down.right" },
  trash: { sf: "trash", fill: "trash.fill" },
  text: { sf: "text.alignleft" },
  eye: { sf: "eye", fill: "eye.fill" },
  down: { sf: "arrow.down" },
  wifi: { sf: "wifi" },
  members: { sf: "person.2", fill: "person.2.fill" },
  person: { sf: "person", fill: "person.fill" },
  replyTo: { sf: "arrowshape.turn.up.left", fill: "arrowshape.turn.up.left.fill" },
  swap: { sf: "arrow.left.arrow.right" },
  updown: { sf: "chevron.up.chevron.down" },
  up: { sf: "arrow.up" },
  wallet: { sf: "wallet.bifold", fill: "wallet.bifold.fill" },
  book: { sf: "book", fill: "book.fill" },
  bulb: { sf: "lightbulb", fill: "lightbulb.fill" },
  pullRequest: { sf: "arrow.triangle.branch" },
  calendar: { sf: "calendar" },
  message: { sf: "message", fill: "message.fill" },
  plug: { sf: "powerplug", fill: "powerplug.fill" },
  audienceEveryone: { sf: "person.3", fill: "person.3.fill" },
  audienceOwner: { sf: "person.badge.key", fill: "person.badge.key.fill" },
  // Live files and their tools (ADR 0196).
  spreadsheet: { sf: "tablecells", fill: "tablecells.fill" },
  slides: { sf: "rectangle.stack", fill: "rectangle.stack.fill" },
  canvas: { sf: "scribble.variable" },
  frame: { sf: "rectangle.dashed" },
  note: { sf: "note.text" },
  shape: { sf: "square.on.circle" },
  textTool: { sf: "textformat" },
  follow: { sf: "eye", fill: "eye.fill" },
  present: { sf: "play.rectangle", fill: "play.rectangle.fill" },
  redo: { sf: "arrow.uturn.forward" },
  paste: { sf: "doc.on.clipboard", fill: "doc.on.clipboard.fill" },
  pointer: { sf: "cursorarrow" },
  arrowTool: { sf: "arrow.up.right" },
  rect: { sf: "rectangle" },
  ellipse: { sf: "circle" },
  diamond: { sf: "diamond" },
  triangle: { sf: "triangle" },
  star: { sf: "star", fill: "star.fill" },
  line: { sf: "line.diagonal" },
  comment: { sf: "ellipsis.bubble", fill: "ellipsis.bubble.fill" },
  crop: { sf: "crop" },
  marker: { sf: "highlighter" },
  curve: { sf: "point.topleft.down.to.point.bottomright.curvepath" },
  elbow: { sf: "arrow.turn.down.right" },
  heading: { sf: "textformat.size" },
};

/** The symbol for an icon (its filled form when `filled` and the system has one), or null to draw our own. */
export function sfSymbolOf(name: IconName, filled = false): SFSymbolName | null {
  const entry = SF_SYMBOLS[name];
  if (!entry) return null;
  return filled ? (entry.fill ?? entry.sf) : entry.sf;
}

/**
 * A symbol's point size in an icon's square box: a symbol's drawing runs about 1.2 times its point size tall (a
 * clock is 1.17), so at 0.72 the usual one fills about 85% of the box, a little more than our line icons did (78%),
 * as the system's symbols sit beside text. Wider ones (two people, a chart) are fitted into the box's width.
 */
export const SF_POINT_SCALE = 0.72;

/** The colors of the system's own Settings tiles (iOS, the same names on Android): one per subject. */
export type TileTint =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "indigo"
  | "purple"
  | "pink"
  | "brown"
  | "gray"
  | "agent";

/**
 * A row's tile color by its icon, fixed, as the system's Settings give each subject its own: the same icon has the
 * same color on every screen. Icons left out take the system's gray (the Settings' General); a destructive row is red
 * whatever its icon. The agent keeps the brand's blue, the only place the brand's color goes.
 */
export const TILE_TINTS: Partial<Record<IconName, TileTint>> = {
  // Alerts, removing, stopping.
  bell: "red",
  trash: "red",
  stop: "red",
  mute: "red",
  // What asks for attention or moves things along.
  flag: "orange",
  bolt: "orange",
  bulb: "orange",
  target: "orange",
  wait: "orange",
  pin: "orange",
  // Done, go, add, money.
  checkc: "green",
  check: "green",
  checks: "green",
  play: "green",
  plus: "green",
  chat: "green",
  text: "green",
  wallet: "green",
  // Seeing and talking back.
  eye: "teal",
  eyeoff: "teal",
  reply: "teal",
  replyTo: "teal",
  message: "teal",
  join: "teal",
  // Files and media.
  drive: "cyan",
  cloud: "cyan",
  image: "cyan",
  photos: "cyan",
  camera: "cyan",
  // People, channels, links, the system's own blue subjects.
  shield: "blue",
  info: "blue",
  help: "blue",
  link: "blue",
  mail: "blue",
  hash: "blue",
  members: "blue",
  person: "blue",
  audienceEveryone: "blue",
  audienceOwner: "blue",
  chart: "blue",
  sun: "blue",
  wifi: "blue",
  send: "blue",
  share: "blue",
  compose: "blue",
  pen: "blue",
  issue: "blue",
  gitPull: "blue",
  pullRequest: "blue",
  // Time and night.
  clock: "indigo",
  calendar: "indigo",
  moon: "indigo",
  // Thinking.
  brain: "purple",
  sparkle: "purple",
  // Sound and feelings.
  sound: "pink",
  smile: "pink",
  sticker: "pink",
  mic: "pink",
  // Pages.
  file: "brown",
  doc: "brown",
  book: "brown",
  // Ours.
  agent: "agent",
  // Files made in the Drive: each kind its own color, as the system gives each of its apps.
  spreadsheet: "teal",
  slides: "orange",
  canvas: "cyan",
};
