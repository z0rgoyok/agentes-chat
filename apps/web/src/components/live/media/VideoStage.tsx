import { VideoPlayer } from "@agenteschat/ui";
import { type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVideoLabels } from "@/components/artifacts/FileView";
import { clockOf } from "../talk";
import { DraftMark } from "./DraftMark";
import { MediaPins, PinFace, usePinAuthor } from "./MediaPins";
import { type Mark, markOf, type StageMarks } from "./marks";

/** Room around the frame inside the stage (pixels). */
export interface StagePad {
  x: number;
  top: number;
  bottom: number;
}

/** A frame's pins show this long around their moment (seconds), as it plays or is paused near it. */
const NEAR_S = 1.5;

/** What the page can do with the video from outside: go to a moment, stop it, know where it is. */
export interface VideoHandle {
  seek(seconds: number): void;
  pause(): void;
  now(): number;
}

/**
 * A video in the viewer with its comments (ADR 0208): our player, the comments as marks over its timeline (the face
 * and the moment; a press goes there and opens the conversation at it), a frame's pins around their moment, and with
 * the comments open a click or a drag on the picture pauses it there and marks that moment with a point or an area
 * (`onMark`, with the video element to take its frame from).
 */
export function VideoStage({
  src,
  handoff,
  name,
  marks,
  pad,
  onMark,
  onHandle,
}: {
  src: string;
  /** The file, to go on from its chat tile's moment (`VideoPlayer`'s `handoff`). */
  handoff?: string;
  name: string;
  marks: StageMarks;
  pad: StagePad;
  onMark: (mark: Mark | null, time: number, video: HTMLVideoElement) => void;
  onHandle?: (handle: VideoHandle | null) => void;
}) {
  const { t } = useTranslation();
  const labels = useVideoLabels();
  const nameOf = usePinAuthor();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState(16 / 9);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      video.current = el;
      if (el) {
        const sized = () => el.videoWidth && el.videoHeight && setRatio(el.videoWidth / el.videoHeight);
        sized();
        el.addEventListener("loadedmetadata", sized);
      }
      onHandle?.(
        el
          ? {
              seek: (s) => {
                el.currentTime = Math.max(0, Number.isFinite(el.duration) ? Math.min(el.duration, s) : s);
              },
              pause: () => el.pause(),
              now: () => el.currentTime,
            }
          : null,
      );
    },
    [onHandle],
  );
  const onTime = useCallback((s: number, d: number) => {
    setTime(s);
    if (Number.isFinite(d) && d > 0) setDuration(d);
  }, []);

  // With Comment on, the video stops where the person is about to mark.
  useEffect(() => {
    if (marks.tool === "comment") video.current?.pause();
  }, [marks.tool]);

  const roomW = Math.max(0, stage.w - pad.x * 2);
  const roomH = Math.max(0, stage.h - pad.top - pad.bottom);
  const boxW = Math.min(roomW, roomH * ratio);
  const boxH = boxW / ratio;

  const timed = marks.pins.filter((p) => p.selection.time !== undefined && (marks.showResolved || !p.resolved));
  const nearNow = marks.pins.filter(
    (p) =>
      p.selection.mark &&
      p.selection.time !== undefined &&
      (p.message.id === marks.focusId || Math.abs(p.selection.time - time) <= NEAR_S),
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (marks.tool !== "comment" || e.button !== 0) return;
    e.stopPropagation();
    video.current?.pause();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ from: { x: e.clientX, y: e.clientY }, to: { x: e.clientX, y: e.clientY } });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ from: drag.from, to: { x: e.clientX, y: e.clientY } });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const r = overlay.current?.getBoundingClientRect();
    const mark = r ? markOf(drag.from, { x: e.clientX, y: e.clientY }, r) : null;
    setDrag(null);
    const v = video.current;
    if (v) onMark(mark, v.currentTime, v);
  };
  const r = drag ? overlay.current?.getBoundingClientRect() : null;
  const dragging = drag && r ? markOf(drag.from, drag.to, r) : null;

  const markers =
    duration > 0
      ? timed.map((pin) => {
          const at = Math.min(1, Math.max(0, (pin.selection.time ?? 0) / duration));
          const label = nameOf(pin);
          return (
            <button
              key={pin.message.id}
              type="button"
              className="mf-mark"
              data-on={pin.message.id === marks.focusId || undefined}
              data-faded={pin.old || pin.resolved ? true : undefined}
              style={{ left: `${at * 100}%` }}
              aria-label={t("files.comments.markAt", { n: pin.n, time: clockOf(pin.selection.time ?? 0), name: label })}
              title={`${pin.n} · ${clockOf(pin.selection.time ?? 0)} · ${label}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (video.current && pin.selection.time !== undefined) {
                  video.current.pause();
                  video.current.currentTime = pin.selection.time;
                }
                marks.onOpenPin(pin.message.id);
              }}
            >
              <PinFace pin={pin} name={label} />
              <span className="tabular">{pin.n}</span>
            </button>
          );
        })
      : null;

  return (
    <div ref={stageRef} className="mf-stage mf-stage--video" data-tool={marks.tool}>
      <div
        className="mf-box mf-box--video"
        style={{
          left: pad.x + (roomW - boxW) / 2,
          top: pad.top + (roomH - boxH) / 2,
          width: boxW || undefined,
          height: boxH || undefined,
          visibility: boxW ? "visible" : "hidden",
        }}
      >
        <VideoPlayer
          src={src}
          handoff={handoff}
          name={name}
          variant="viewer"
          labels={labels}
          onTime={onTime}
          onVideo={onVideo}
          marks={markers}
          // A comment's pictures are this video's frame: drawn from another origin, they couldn't be read back.
          crossOrigin="anonymous"
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Comment's marking surface; the keys stay the player's */}
          <div
            ref={overlay}
            className="mf-overlay"
            data-active={marks.tool === "comment" || undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
          >
            <MediaPins
              pins={nearNow}
              focusId={marks.focusId}
              showResolved={marks.showResolved}
              onOpen={marks.onOpenPin}
            />
            {dragging?.w !== undefined ? <DraftMark mark={dragging} /> : marks.draft && <DraftMark {...marks.draft} />}
          </div>
        </VideoPlayer>
      </div>
    </div>
  );
}
