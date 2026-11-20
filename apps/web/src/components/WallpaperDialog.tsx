import { useSetChatPrefs, useSetConversationWallpaper, useUploadWallpaperPhoto } from "@agenteschat/client";
import { chatLookOf, DEFAULT_TEXT_SIZE, facesShown } from "@agenteschat/client/lib/chat-look";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  conversationWallpaperOf,
  DEFAULT_PHOTO_DIM,
  defaultWallpaperOf,
  hasWallpaper,
  MAX_PHOTO_DIM,
  NO_WALLPAPER,
  resolveWallpaper,
  sameWallpaper,
  WALLPAPER_FAMILIES,
  type Wallpaper,
  type WallpaperHue,
  wallpaperHueOf,
  wallpaperName,
} from "@agenteschat/client/lib/wallpaper";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  type AgentColor,
  agentGradient,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  Locked,
  MessageLookContext,
  OptionList,
  useDarkTheme,
  useUnsavedInDialog,
} from "@agenteschat/ui";
import { mix } from "@agenteschat/ui/sky/math";
import { WALLPAPER_PAGE, wallpaperStrength } from "@agenteschat/ui/sky/wallpaper";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SAMPLE_AGENT, type SampleLine, SampleMini, SampleRows } from "@/components/ChatSamples";
import { ChatWallpaper, WallpaperThumb } from "@/components/ChatWallpaper";
import { useOrg } from "@/components/org-context";
import { fileToBase64 } from "@/components/ProfilePhoto";
import { useToast } from "@/lib/toast";
import { wallpaperVars } from "@/lib/wallpaper-paint";

/** "auto" in the DMs' picker: every agent in its own color, three of them side by side. */
const AUTO_BANDS: readonly WallpaperHue[] = ["green", "sky", "rose"];
/** The DMs' samples are with the samples' agent: "auto" takes its color there. */
const SAMPLE_HUE: WallpaperHue = wallpaperHueOf(SAMPLE_AGENT.color) ?? "sky";
const FAMILIES = ["sky", "drawings", "color"] as const;
/** A photo goes up as a JPEG of at most this side and this size (what the server takes). */
const PHOTO_SIDE = 1920;
const PHOTO_BYTES = 2 * 1024 * 1024;

type Photo = Extract<Wallpaper, { kind: "photo" }>;

/** A photo being framed before it is used: its point of interest, how dark it goes in the dark theme. */
interface Draft {
  /** The file picked, sent on Use this photo; null for the photo already in use, framed again. */
  file: File | null;
  /** The file's own address in this page, or the photo's. */
  url: string;
  x: number;
  y: number;
  dim: number;
  /** Its own size: how far a drag moves it. */
  w: number;
  h: number;
  img: HTMLImageElement | null;
}

/** One conversation, from its header's menu: its own background, over the one behind every conversation. */
export interface WallpaperConversation {
  channelId: string;
  dm: boolean;
  /** "#support", "Ada": where the choice applies. */
  name: string;
  /** The agent of a DM with one: "auto" takes its color. */
  agentColor?: AgentColor | null;
}

/** A background's name (`wallpaperName`), with the web's `t`, which checks its keys. */
export function useWallpaperName() {
  const { t } = useTranslation();
  return (w: Wallpaper, dm: boolean | null) =>
    wallpaperName((key, params) => String(t(key as never, params as never)), w, dm);
}

/** The base64 to send for a photo: a JPEG of at most `PHOTO_SIDE` and `PHOTO_BYTES`, else the file as it is. */
async function shrinkPhoto(file: File, img: HTMLImageElement | null) {
  try {
    const canvas = img && img.naturalWidth > 0 ? document.createElement("canvas") : null;
    const ctx = canvas?.getContext?.("2d");
    if (img && canvas && ctx && typeof canvas.toDataURL === "function") {
      const scale = Math.min(1, PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      // A transparent picture on white, not on a JPEG's black.
      ctx.fillStyle = WALLPAPER_PAGE.light;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.76, 0.64, 0.5]) {
        const url = canvas.toDataURL("image/jpeg", quality);
        const data = url.slice(url.indexOf(",") + 1);
        if (url.startsWith("data:image/jpeg") && data && (data.length * 3) / 4 <= PHOTO_BYTES)
          return { imageBase64: data, contentType: "image/jpeg" };
      }
    }
  } catch {
    // No canvas here: the file goes as it is, and the server says when it can't take it.
  }
  return { imageBase64: await fileToBase64(file), contentType: file.type || "image/jpeg" };
}

/**
 * Background: what is behind a conversation, mine alone, on every device. With no `conversation` (Settings ›
 * Conversations) the one behind every conversation; from a conversation's menu, its own, with Same as other
 * conversations first. Each family is one row of tiles; a tile applies at once and the preview
 * beside them shows it on the conversation's own rows. A photo is framed in the preview (dragged to its point of
 * interest, darkened for the dark theme) and sent with Use this photo. Done only closes.
 */
export function WallpaperDialog({
  open,
  onOpenChange,
  conversation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation?: WallpaperConversation;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.account.chat.wallpaper.title")}
      description={
        conversation ? t("settings.account.chat.wallpaper.onlyHere", { name: conversation.name }) : undefined
      }
      closeLabel={t("common.close")}
      width={820}
      className="wallpaper-dialog"
    >
      <WallpaperPicker conversation={conversation} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

/**
 * The dialog's content, mounted while it is open: each opening starts with nothing half framed. A
 * photo being framed holds the dialog open against a press outside or Esc.
 */
function WallpaperPicker({ conversation, onDone }: { conversation?: WallpaperConversation; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const dark = useDarkTheme();
  const nameOf = useWallpaperName();
  const setPrefs = useSetChatPrefs(org.id);
  const setOwn = useSetConversationWallpaper(org.id);
  const upload = useUploadWallpaperPhoto(org.id);
  const ids = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; from: Draft } | null>(null);
  useUnsavedInDialog(draft !== null);

  // A picked file's address lives as long as its draft.
  const fileUrl = draft?.file ? draft.url : null;
  useEffect(
    () => () => {
      if (fileUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(fileUrl);
    },
    [fileUrl],
  );

  const prefs = org.chatPrefs;
  // The preview is a DM with the samples' agent unless this is one conversation; names say what "auto" is here
  // (null: each conversation's own).
  const dm = conversation ? conversation.dm : true;
  const scope = conversation ? conversation.dm : null;
  const others = defaultWallpaperOf(prefs);
  // What is chosen here; undefined in a conversation: the same as the others.
  const chosen = conversation ? conversationWallpaperOf(prefs, conversation.channelId) : others;
  const hue = conversation ? wallpaperHueOf(conversation.agentColor) : SAMPLE_HUE;
  // For every conversation, the tiles show "auto" as every agent's color; the preview, as the samples' agent's.
  const bands = conversation ? undefined : AUTO_BANDS;
  const tileOf = (w: Wallpaper) => (bands ? w : resolveWallpaper(w, hue));
  const { style, tone } = chatLookOf(prefs, dm, isPersonal(org));
  const page = WALLPAPER_PAGE[dark ? "dark" : "light"];
  /** My bubble on a tile: the tile's own color, else the conversation's (as `bubbles` mixes it). */
  const mineOn = (w: Wallpaper) => {
    if (w.kind === "photo") return WALLPAPER_PAGE.light;
    const color = ("color" in w ? wallpaperHueOf(w.color) : null) ?? hue ?? "sky";
    return mix(page, agentGradient(color)[1], dark ? 0.3 : 0.2);
  };

  const failed = () => toast.show(t("settings.account.chat.wallpaper.failed"), "error");
  /** Applies at once (shown before the server answers); null: the conversation follows the others again. */
  const apply = (w: Wallpaper | null) => {
    if (conversation) {
      setOwn.mutate({ channelId: conversation.channelId, wallpaper: w }, { onError: failed });
      return;
    }
    const value = w ?? NO_WALLPAPER;
    setPrefs.mutate({ wallpaper: value }, { onError: failed });
  };
  const pick = (w: Wallpaper | null) => {
    setDraft(null);
    apply(w);
  };

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") {
      toast.show(t("errors.wallpaper.type"), "error");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () =>
      setDraft({ file, url, x: 0.5, y: 0.5, dim: DEFAULT_PHOTO_DIM, w: img.naturalWidth, h: img.naturalHeight, img });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast.show(t("errors.wallpaper.type"), "error");
    };
    img.src = url;
  };
  /** The photo in use, framed again (its tile pressed once more). */
  const reframe = (photo: Photo) => {
    const img = new Image();
    img.onload = () => setDraft({ ...photo, file: null, w: img.naturalWidth, h: img.naturalHeight, img });
    img.src = photo.url;
  };
  /** A drag of (dx, dy) points from `from`: the point of interest moves the other way, as far as the cover reaches. */
  const moved = (from: Draft, dx: number, dy: number): Draft => {
    const el = preview.current;
    if (!el || from.w <= 0 || from.h <= 0) return from;
    const scale = Math.max(el.clientWidth / from.w, el.clientHeight / from.h);
    const overX = from.w * scale - el.clientWidth;
    const overY = from.h * scale - el.clientHeight;
    const unit = (v: number) => Math.min(1, Math.max(0, v));
    return {
      ...from,
      x: overX > 0.5 ? unit(from.x - dx / overX) : from.x,
      y: overY > 0.5 ? unit(from.y - dy / overY) : from.y,
    };
  };
  const savePhoto = async () => {
    const d = draft;
    if (!d || sending) return;
    setSending(true);
    try {
      const url = d.file ? (await upload.mutateAsync(await shrinkPhoto(d.file, d.img))).url : d.url;
      apply({ kind: "photo", url, dim: d.dim, x: d.x, y: d.y });
      setDraft(null);
    } catch (e) {
      toast.show(errorText(t, e), "error");
    } finally {
      setSending(false);
    }
  };

  const shown: Wallpaper = draft
    ? { kind: "photo", url: draft.url, dim: draft.dim, x: draft.x, y: draft.y }
    : resolveWallpaper(chosen ?? others, hue);
  const plain = chosen === undefined ? "same" : chosen.kind === "none" ? "none" : "";
  const talk: SampleLine[] = [
    { who: "me", text: t("settings.account.chat.sample.ask"), time: "14:30" },
    { who: "agent", text: t("settings.account.chat.sample.answer"), time: "14:31" },
    { who: "me", text: t("settings.account.chat.sample.go"), time: "14:32" },
  ];
  const look = { style, tone, mine: agentGradient(hue ?? "sky")[1], names: !dm, faces: facesShown(style, dm) };
  const percent = new Intl.NumberFormat(i18n.language, { style: "percent" });
  const tile = (w: Wallpaper, onPick: () => void) => (
    <WallpaperTile
      key={`${w.kind}:${"color" in w ? w.color : ""}`}
      wallpaper={tileOf(w)}
      bands={bands}
      label={nameOf(w, scope)}
      mine={mineOn(w)}
      selected={chosen !== undefined && sameWallpaper(chosen, w)}
      onPick={onPick}
    />
  );

  return (
    <>
      <Locked when={sending}>
        <DialogBody className="wallpaper-dialog__body" style={wallpaperVars(dark)}>
          <div className="wallpaper-dialog__cols">
            <div className="wallpaper-dialog__choices">
              <OptionList<"same" | "none" | "">
                className="wallpaper-dialog__plain"
                layout="tiles"
                aria-label={t("settings.account.chat.wallpaper.title")}
                value={plain}
                onValueChange={(v) => pick(v === "same" ? null : NO_WALLPAPER)}
                options={[
                  ...(conversation
                    ? [
                        {
                          value: "same" as const,
                          title: t("settings.account.chat.wallpaper.sameAsOthers"),
                          description: nameOf(others, scope),
                          ...(hasWallpaper(others)
                            ? { leading: <WallpaperThumb wallpaper={resolveWallpaper(others, hue)} /> }
                            : {}),
                        },
                      ]
                    : []),
                  { value: "none" as const, title: t("settings.account.chat.wallpaper.none") },
                ]}
              />
              {/* Each tile says its family in its own name ("Sky · Rose"). */}
              {FAMILIES.map((family) => (
                <div key={family} className="wallpaper-dialog__family">
                  <span className="wallpaper-dialog__family-name">
                    {t(`settings.account.chat.wallpaper.${family}`)}
                  </span>
                  <div className="wallpaper-dialog__tiles">
                    {WALLPAPER_FAMILIES[family].map((w) => tile(w, () => pick(w)))}
                  </div>
                </div>
              ))}
              <div className="wallpaper-dialog__family">
                <span className="wallpaper-dialog__family-name">{t("settings.account.chat.wallpaper.photos")}</span>
                <div className="wallpaper-dialog__photos">
                  {chosen?.kind === "photo" && tile(chosen, () => reframe(chosen))}
                  <Button size="sm" icon="image" onClick={() => input.current?.click()}>
                    {t("settings.account.chat.wallpaper.choosePhoto")}
                  </Button>
                  <input
                    ref={input}
                    type="file"
                    accept="image/*"
                    className="ac-visually-hidden"
                    tabIndex={-1}
                    aria-label={t("settings.account.chat.wallpaper.choosePhoto")}
                    onChange={(e) => {
                      choose(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="wallpaper-dialog__side">
              <div
                ref={preview}
                className="wallpaper-preview"
                role="img"
                aria-label={t(
                  draft ? "settings.account.chat.wallpaper.dragHint" : "settings.account.chat.wallpaper.preview",
                )}
                data-drag={draft ? "" : undefined}
                onPointerDown={(e) => {
                  if (!draft || sending) return;
                  drag.current = { x: e.clientX, y: e.clientY, from: draft };
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (d) setDraft(moved(d.from, e.clientX - d.x, e.clientY - d.y));
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                {hasWallpaper(shown) && (
                  <ChatWallpaper wallpaper={shown} strength={wallpaperStrength(style === "bubbles")} />
                )}
                <MessageLookContext.Provider value={look}>
                  <SampleMini
                    look={style}
                    size={DEFAULT_TEXT_SIZE}
                    faces={look.faces}
                    wallpaper={hasWallpaper(shown) ? shown.kind : undefined}
                  >
                    <SampleRows lines={talk} />
                  </SampleMini>
                </MessageLookContext.Provider>
              </div>
              {draft ? (
                <>
                  <p className="wallpaper-dialog__note">{t("settings.account.chat.wallpaper.dragHint")}</p>
                  {dark && (
                    <label className="wallpaper-dialog__dim" htmlFor={`${ids}-dim`}>
                      <span className="wallpaper-dialog__dim-line">
                        <span>{t("settings.account.chat.wallpaper.dim")}</span>
                        <b>{percent.format(draft.dim)}</b>
                      </span>
                      <input
                        id={`${ids}-dim`}
                        type="range"
                        min={0}
                        max={Math.round(MAX_PHOTO_DIM * 100)}
                        step={1}
                        value={Math.round(draft.dim * 100)}
                        style={{ "--p": `${(draft.dim / MAX_PHOTO_DIM) * 100}%` } as CSSProperties}
                        onChange={(e) => setDraft({ ...draft, dim: Number(e.target.value) / 100 })}
                      />
                    </label>
                  )}
                  <div className="wallpaper-dialog__photo-acts">
                    <Button size="sm" onClick={() => setDraft(null)}>
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" variant="primary" loading={sending} onClick={() => void savePhoto()}>
                      {sending
                        ? t("settings.account.chat.wallpaper.sending")
                        : t("settings.account.chat.wallpaper.usePhoto")}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="wallpaper-dialog__note">
                  {t(
                    !conversation
                      ? "settings.account.chat.wallpaper.skyAutoHelp"
                      : conversation.dm
                        ? "settings.account.chat.wallpaper.skyAutoHelpDms"
                        : "settings.account.chat.wallpaper.skyAutoHelpChannels",
                  )}
                </p>
              )}
            </div>
          </div>
        </DialogBody>
      </Locked>
      <DialogFooter note={conversation ? undefined : t("settings.account.chat.wallpaper.help")}>
        <Button variant="primary" onClick={onDone}>
          {t("settings.account.chat.wallpaper.done")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** A tile: the background in small, someone's bubble and mine on it; the chosen one ringed, with a check. */
function WallpaperTile({
  wallpaper,
  bands,
  label,
  mine,
  selected,
  onPick,
}: {
  wallpaper: Wallpaper;
  bands?: readonly WallpaperHue[];
  label: string;
  /** My bubble's color on it. */
  mine: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="wallpaper-tile"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onPick}
    >
      <ChatWallpaper wallpaper={wallpaper} bands={bands} small />
      <span className="wallpaper-tile__bubble wallpaper-tile__bubble--theirs" />
      <span className="wallpaper-tile__bubble wallpaper-tile__bubble--mine" style={{ background: mine }} />
      {selected && (
        <span className="wallpaper-tile__check">
          <Icon name="check" size={14} />
        </span>
      )}
    </button>
  );
}
