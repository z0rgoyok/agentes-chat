import type { LiveRoom } from "@agenteschat/client";
import { colIds, formatA1Range, peerColor, readableOn, rowIds, sheetIds, slideIdsOf } from "@agenteschat/live";
import type { Peer, PeerState, PeerUser } from "@agenteschat/live/awareness";
import { sheetName } from "@agenteschat/live/spreadsheet";
import { AvatarStack, Button, cx, gradientOf, Popover, useDarkTheme } from "@agenteschat/ui";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

/**
 * Who is in a live file, as every editor draws them (ADR 0196 §5): a name, a color and a face for each person and
 * agent, the stack of faces in the page's header with where each one is, and the island that says whom you follow.
 *
 * Colors: people get `peerColor` (ten hues that read on the theme's surfaces, none the agents' blue); agents keep their
 * own look's tone, the one their face is drawn in (the deep one on light, the top one on dark, as their names in
 * messages). The person's own selection is never one of these: it is ink (the editors' own CSS).
 */

/** How a peer is drawn. */
export interface PeerLook {
  user: PeerUser;
  /** Their name as the workspace knows it. */
  name: string;
  /** Their color in this theme: rings, cursors, selections, the words saying where they are. */
  color: string;
  /** Words on `color` (a name tag): whichever of white and ink reads on it. */
  onColor: string;
}

/** Words on a peer's color: the light theme's colors read white on them, the dark theme's ink. */
const TAG_INKS = ["#ffffff", "#10141a"] as const;

/**
 * Each peer's look, as a function (for lists: the faces, the cursors, the selections of everyone in the file). The
 * colors follow the theme; names come from the workspace's directory (one no longer in it reads as unknown).
 */
export function usePeerLooks(): (user: PeerUser) => PeerLook {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const dark = useDarkTheme();
  return useCallback(
    (user: PeerUser): PeerLook => {
      if (user.kind === "agent") {
        const agent = dir.anyAgent(user.id);
        const [top, deep] = gradientOf(lookOf(agent)?.color ?? "sky");
        const color = dark ? top : deep;
        return {
          user,
          name: agent?.name ?? t("channel.unknownAgent"),
          color,
          onColor: readableOn(color, TAG_INKS),
        };
      }
      const color = peerColor(user.id, dark);
      return {
        user,
        name: dir.memberById.get(user.id)?.name ?? t("channel.unknownPerson"),
        color,
        onColor: readableOn(color, TAG_INKS),
      };
    },
    [dir, dark, t],
  );
}

/** One peer's look (null for none). */
export function usePeerLook(user: PeerUser | null | undefined): PeerLook | null {
  const looks = usePeerLooks();
  const kind = user?.kind;
  const id = user?.id;
  return useMemo(() => (kind && id ? looks({ kind, id }) : null), [looks, kind, id]);
}

/** An agent at work in the file (editing): its face is alive, writing. */
export const peerWorking = (peer: Pick<Peer, "user" | "state">) =>
  peer.user.kind === "agent" && peer.state.mode === "editing";

/**
 * A peer's face: a person's photo or initials in a circle, an agent's living symbol (writing while it works in the
 * file). `ring` draws the 2 px ring in their color around the surface's own (the header's stack).
 */
export function PeerFace({
  user,
  name,
  color,
  size = "sm",
  working = false,
  ring = false,
  labelled = false,
  className,
}: {
  user: PeerUser;
  name: string;
  color?: string;
  size?: "xs" | "sm";
  working?: boolean;
  ring?: boolean;
  /** No name beside it: screen readers read the face's. */
  labelled?: boolean;
  className?: string;
}) {
  const style = color ? ({ "--peer": color } as CSSProperties) : undefined;
  const cls = cx("lf-face", ring && "lf-face--ring", className);
  if (user.kind === "agent") {
    return (
      <AgentAvatar
        agentId={user.id}
        name={name}
        size={size}
        state={working ? "writing" : "idle"}
        running={working}
        labelled={labelled}
        className={cls}
        style={style}
      />
    );
  }
  return <PersonAvatar id={user.id} name={name} size={size} labelled={labelled} className={cls} style={style} />;
}

/** A sheet's range by its row and column ids as A1 ("B4:E10"), or null when those rows or columns are gone. */
function rangeOf(room: LiveRoom, sel: NonNullable<NonNullable<PeerState["sel"]>["sheet"]>): string | null {
  const doc = room.doc;
  const rows = rowIds(doc, sel.sheet);
  const cols = colIds(doc, sel.sheet);
  const r1 = rows.indexOf(sel.r1);
  const r2 = rows.indexOf(sel.r2);
  const c1 = cols.indexOf(sel.c1);
  const c2 = cols.indexOf(sel.c2);
  if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null;
  const range = formatA1Range(r1, c1, r2, c2);
  // With more than one sheet, which one ("Planilha 2!B4").
  return sheetIds(doc).length > 1 ? `${sheetName(doc, sel.sheet)}!${range}` : range;
}

/**
 * Where a peer is and what they do, in a few words in the person's language: an agent's own activity ("escrevendo em
 * B2:E40"), presenting, the range or slide they edit or look at ("editando B4:E10", "no slide 3"), else editing or
 * viewing.
 */
export function usePeerDoing(room: LiveRoom | null): (peer: Peer) => string {
  const { t, i18n } = useTranslation();
  return useCallback(
    (peer: Peer) => {
      const s = peer.state;
      if (peer.user.kind === "agent" && s.activity) {
        const key = `live.activity.${s.activity.key}`;
        // A key a newer server sends that this app doesn't know yet: its general words.
        const words = t as unknown as (key: string, params: Record<string, string>) => string;
        return i18n.exists(key) ? words(key, s.activity.params ?? {}) : t("live.activity.working");
      }
      if (s.presenting) return t("live.shell.presence.presenting");
      const editing = s.mode === "editing";
      try {
        if (room && !room.destroyed && s.sel?.sheet) {
          const range = rangeOf(room, s.sel.sheet);
          if (range) return t(editing ? "live.shell.presence.editingRange" : "live.shell.presence.atRange", { range });
        }
        if (room && !room.destroyed && s.at?.slide) {
          const n = slideIdsOf(room.doc).indexOf(s.at.slide) + 1;
          if (n > 0) return t(editing ? "live.shell.presence.editingSlide" : "live.shell.presence.onSlide", { n });
        }
      } catch {
        // A document mid-change: the plain words below.
      }
      return t(editing ? "live.shell.presence.editing" : "live.shell.presence.viewing");
    },
    [room, t, i18n],
  );
}

/** Faces shown in the header before "+N". */
export const STACK_FACES = 4;

/**
 * The faces of who else is in the file, in the page's header (ADR 0196 §5): up to four, each ringed in their color
 * (an agent's alive while it works), then "+N". Pressing it lists everyone, this person first ("You"), each with
 * where they are in their color and Follow / Stop following. Nobody else here: nothing.
 */
export function PresenceStack({
  room,
  peers,
  followingId,
  onFollow,
  open,
  onOpenChange,
}: {
  room: LiveRoom | null;
  peers: Peer[];
  /** The awareness client id of whom this person follows. */
  followingId: number | null;
  onFollow: (peer: Peer | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const looks = usePeerLooks();
  const doing = usePeerDoing(room);
  const others = peers.filter((p) => !p.self);
  if (others.length === 0) return null;
  const shown = others.slice(0, STACK_FACES);
  const extra = others.length - shown.length;
  const names = others.map((p) => looks(p.user).name);
  const label = t("live.shell.presence.label", { names: names.join(", ") });
  return (
    <Popover
      label={t("live.shell.presence.title")}
      side="bottom"
      align="end"
      className="lf-people"
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <button type="button" className="lf-stack" aria-label={label} title={label}>
          <AvatarStack className="lf-stack__faces">
            {shown.map((p) => {
              const look = looks(p.user);
              return (
                <PeerFace
                  key={p.clientId}
                  user={p.user}
                  name={look.name}
                  color={look.color}
                  working={peerWorking(p)}
                  ring
                />
              );
            })}
          </AvatarStack>
          {extra > 0 && (
            <span className="lf-stack__more tabular">{t("live.shell.presence.more", { count: extra })}</span>
          )}
        </button>
      }
    >
      <ul className="lf-people__list">
        {peers.map((p) => {
          const look = looks(p.user);
          const followed = followingId === p.clientId;
          return (
            <li key={p.clientId} className="lf-people__row">
              <span className="lf-people__line ac-iconline">
                <PeerFace user={p.user} name={look.name} color={look.color} working={peerWorking(p)} />
                <span className="lf-people__who">
                  <span className="lf-people__name">
                    {p.self ? t("live.shell.presence.you") : look.name}
                    {p.user.kind === "agent" && !p.self && (
                      <span className="lf-people__kind"> {t("live.shell.presence.agent")}</span>
                    )}
                  </span>
                  <span className="lf-people__doing" style={{ color: p.self ? undefined : look.color }}>
                    {doing(p)}
                  </span>
                </span>
              </span>
              {!p.self && (
                <Button
                  variant="link"
                  className="lf-people__follow"
                  aria-pressed={followed}
                  onClick={() => onFollow(followed ? null : p)}
                >
                  {followed ? t("live.shell.presence.unfollow") : t("live.shell.presence.follow")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Popover>
  );
}

/**
 * "Seguindo Ada · Parar": a small glass island at the top of the editor while this person's view follows someone's.
 * Esc stops too (unless something on top takes it first).
 */
export function FollowingIsland({ peer, onStop }: { peer: Peer; onStop: () => void }) {
  const { t } = useTranslation();
  const look = usePeerLook(peer.user);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role='dialog'], [role='menu']")) return;
      onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStop]);
  if (!look) return null;
  return (
    <div className="lf-island ac-glass" role="status" style={{ "--peer": look.color } as CSSProperties}>
      <PeerFace user={peer.user} name={look.name} size="xs" working={peerWorking(peer)} />
      <span className="lf-island__words">{t("live.shell.presence.following", { name: look.name })}</span>
      <Button variant="link" className="lf-island__stop" onClick={onStop}>
        {t("live.shell.presence.stop")}
      </Button>
    </div>
  );
}

/** A peer's name tag in their color (a selection's corner, a slide's element): small words, on-color. */
export function PeerTag({ look, children, className }: { look: PeerLook; children?: ReactNode; className?: string }) {
  return (
    <span
      className={cx("lf-tag", className)}
      style={{ "--peer": look.color, "--peer-on": look.onColor } as CSSProperties}
    >
      {children ?? look.name}
    </span>
  );
}
