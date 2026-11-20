import type { Wallpaper, WallpaperHue } from "@agenteschat/client/lib/wallpaper";
import { cx, drawnKey, useDarkTheme } from "@agenteschat/ui";
import { WALLPAPER_PAGE } from "@agenteschat/ui/sky/wallpaper";
import { useLayoutEffect, useRef, useState } from "react";
import { paintWallpaper } from "@/lib/wallpaper-paint";
import "./chat-wallpaper.css";

/**
 * A conversation's background (packages/client/src/lib/wallpaper.ts), resolved, filling the box it is in under
 * everything else there (the box isolates it: `chat-wallpaper.css`). The sky, the drawings and a color are painted on
 * a canvas sized to the box, again only when the box's size, the theme or the background changes; a photo is the
 * box's cover image, its point of interest kept on screen, darkened in the dark theme by its `dim`. `strength` under 1
 * lays the page over it (the looks with no bubbles take it at half). `small`: a picker's tile or a thumbnail.
 */
export function ChatWallpaper({
  wallpaper,
  strength = 1,
  small = false,
  bands,
  className,
}: {
  wallpaper: Wallpaper;
  strength?: number;
  small?: boolean;
  /** "auto" left in `wallpaper` (the DMs' picker): these colors side by side. */
  bands?: readonly WallpaperHue[];
  className?: string;
}) {
  const dark = useDarkTheme();
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const photo = wallpaper.kind === "photo" ? wallpaper : null;
  // Read by the paint below, which runs only when what it draws changes (`drawn`), not on every render.
  const latest = useRef({ wallpaper, bands });
  latest.current = { wallpaper, bands };
  const color = "color" in wallpaper ? wallpaper.color : "";
  // With the sky as drawn now: the crowd and "auto" draw `sky`, which follows the workspace's accent.
  const drawn = photo ? "" : `${wallpaper.kind}:${color}:${bands?.join(",") ?? ""}:${drawnKey("sky")}`;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = (width: number, height: number) => {
      const next = { w: Math.round(width), h: Math.round(height) };
      setSize((s) => (s && s.w === next.w && s.h === next.h ? s : next));
    };
    const rect = el.getBoundingClientRect();
    read(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) read(r.width, r.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!drawn || !size || !el) return;
    const { wallpaper: w, bands: b } = latest.current;
    paintWallpaper(el, size.w, size.h, w, { dark, small, bands: b, ratio: window.devicePixelRatio });
  }, [drawn, size, dark, small]);

  const page = WALLPAPER_PAGE[dark ? "dark" : "light"];
  return (
    // Spans, so it may sit in a button (a picker's tile); each layer is a block by its position.
    <span ref={box} className={cx("chat-wallpaper", className)} data-kind={wallpaper.kind} aria-hidden="true">
      {photo ? (
        <>
          <span
            className="chat-wallpaper__photo"
            style={{
              backgroundImage: `url("${photo.url}")`,
              backgroundPosition: `${photo.x * 100}% ${photo.y * 100}%`,
            }}
          />
          {dark && photo.dim > 0 && <span className="chat-wallpaper__dim" style={{ opacity: photo.dim }} />}
        </>
      ) : (
        <canvas ref={canvas} className="chat-wallpaper__canvas" />
      )}
      {strength < 1 && <span className="chat-wallpaper__veil" style={{ background: page, opacity: 1 - strength }} />}
    </span>
  );
}

/** A background in small, in its own rounded box with a hairline: a settings row's, an option's. */
export function WallpaperThumb({
  wallpaper,
  bands,
  className,
}: {
  wallpaper: Wallpaper;
  bands?: readonly WallpaperHue[];
  className?: string;
}) {
  return (
    <span className={cx("wallpaper-thumb", className)} aria-hidden="true">
      <ChatWallpaper wallpaper={wallpaper} bands={bands} small />
    </span>
  );
}
