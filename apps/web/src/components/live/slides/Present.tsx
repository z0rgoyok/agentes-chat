import type { DeckView, SlideView } from "@agenteschat/live/slides";
import { themeOf } from "@agenteschat/live/slides";
import { Button } from "@agenteschat/ui";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fitScale } from "./geometry";
import { Scaled, SlideBody } from "./render";
import { useBoxSize } from "./useBoxSize";

/**
 * Presenting a deck (ADR 0196 §2, §5): the slide alone on black, filling the screen, moved with the keys a clicker
 * sends; a glass bar shows on mouse move (‹ 3 / 12 ›, Notes, Exit). With Notes on a wide window it is the presenter's
 * view: this slide, the next, the notes and the time. Hidden slides are skipped. Following someone who presents, it
 * shows their slide and moves with them.
 *
 * It draws inside the live file's page, never in a portal: the page is the element the browser shows full screen
 * (`requestFullscreen` runs inside the press that started presenting), and only what is inside it shows there. When
 * the browser refuses, the page fills the window instead and this still covers it.
 */

/** The slides shown when presenting: the hidden ones are skipped (all of them when every one is hidden). */
export function shownSlides(deck: DeckView): SlideView[] {
  const shown = deck.slides.filter((s) => !s.hidden);
  return shown.length ? shown : deck.slides;
}

/** Where a presentation at `slideId` is: that slide, or the first shown one after it when it is hidden. */
export function presentIndex(deck: DeckView, slideId: string | undefined): number {
  const slides = shownSlides(deck);
  const at = slides.findIndex((s) => s.id === slideId);
  if (at >= 0) return at;
  const from = deck.slides.findIndex((s) => s.id === slideId);
  if (from < 0) return 0;
  const after = slides.findIndex((s) => s.index > from);
  return after >= 0 ? after : Math.max(0, slides.length - 1);
}

/** The presenter's view needs room for two slides and the notes. */
export const PRESENTER_MIN_WIDTH = 960;
/** The bar goes after this long without a mouse move. */
const BAR_IDLE_MS = 2500;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export interface PresentProps {
  deck: DeckView;
  /** The slide shown (an id of `deck`). */
  slideId: string;
  /** Presenting: the person moved to another slide. Absent while following someone (their slide is shown). */
  onSlide?: (id: string) => void;
  onExit: () => void;
  /** "Seguindo Ada": whom this person follows, in place of the slide counter's arrows. */
  following?: { name: string } | null;
}

export function Present({ deck, slideId, onSlide, onExit, following }: PresentProps) {
  const { t } = useTranslation();
  const slides = shownSlides(deck);
  const index = presentIndex(deck, slideId);
  const slide = slides[index];
  const next = slides[index + 1] ?? null;
  const theme = themeOf(deck.theme);
  const root = useRef<HTMLDivElement | null>(null);
  const [room, size] = useBoxSize<HTMLDivElement>();
  const [presenter, setPresenter] = useState(false);
  const [bar, setBar] = useState(true);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wide = (size.w || window.innerWidth) >= PRESENTER_MIN_WIDTH;
  const showPresenter = presenter && wide && !following;

  const go = (to: number) => {
    if (!onSlide) return;
    const target = slides[Math.max(0, Math.min(slides.length - 1, to))];
    if (target && target.id !== slide?.id) onSlide(target.id);
  };

  // The keys reach the presentation at once (a clicker's arrows, Space).
  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!showPresenter) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [showPresenter]);

  const wake = () => {
    setBar(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setBar(false), BAR_IDLE_MS);
  };
  useEffect(() => {
    idle.current = setTimeout(() => setBar(false), BAR_IDLE_MS);
    return () => clearTimeout(idle.current);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const forward = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"];
    const back = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"];
    if (e.key === "Escape") onExit();
    else if (forward.includes(e.key)) go(index + 1);
    else if (back.includes(e.key)) go(index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(slides.length - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (!slide) return null;
  const roomW = size.w || window.innerWidth;
  const roomH = size.h || window.innerHeight;
  const stageW = showPresenter ? roomW * 0.62 : roomW;
  const stageH = showPresenter ? roomH * 0.7 : roomH;
  const scale = fitScale(stageW, stageH, deck.w, deck.h, showPresenter ? 24 : 0);
  const current = (
    <Scaled scale={scale} w={deck.w} h={deck.h} className="sl-present__slide">
      <SlideBody slide={slide} theme={theme} mode="show" w={deck.w} h={deck.h} />
    </Scaled>
  );

  return (
    <div
      ref={(el) => {
        root.current = el;
        room(el);
      }}
      className="sl-present"
      data-presenter={showPresenter ? "true" : undefined}
      data-bar={bar ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-label={t("live.slides.present.label")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerMove={wake}
    >
      {showPresenter ? (
        <div className="sl-present__presenter">
          <div className="sl-present__now">{current}</div>
          <aside className="sl-present__side">
            <div className="sl-present__time">
              <span className="sl-present__caption">{t("live.slides.present.elapsed")}</span>
              <span className="sl-present__clock tabular">{clock(now - started)}</span>
            </div>
            <div className="sl-present__next">
              <span className="sl-present__caption">{t("live.slides.present.next")}</span>
              {next ? (
                <Scaled scale={280 / deck.w} w={deck.w} h={deck.h} className="sl-present__nextslide">
                  <SlideBody slide={next} theme={theme} mode="show" w={deck.w} h={deck.h} />
                </Scaled>
              ) : (
                <span className="sl-present__end">{t("live.slides.present.lastSlide")}</span>
              )}
            </div>
            <div className="sl-present__notes">
              <span className="sl-present__caption">{t("live.slides.notes.title")}</span>
              <p className="sl-present__notes-text">{slide.notes || t("live.slides.present.noNotes")}</p>
            </div>
          </aside>
        </div>
      ) : (
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click moves on, as a clicker does; the keys are the whole presentation's (above)
        <div className="sl-present__stage" onClick={() => go(index + 1)}>
          {current}
        </div>
      )}
      <div className="sl-present__bar ac-glass" role="toolbar" aria-label={t("live.slides.present.controls")}>
        {following ? (
          <span className="sl-present__following">{t("live.slides.present.following", { name: following.name })}</span>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon="chevronLeft"
              aria-label={t("live.slides.present.previous")}
              disabled={index === 0}
              onClick={() => go(index - 1)}
            />
            <span className="sl-present__count tabular" aria-live="polite">
              {t("live.slides.present.count", { n: index + 1, total: slides.length })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon="chevronRight"
              aria-label={t("live.slides.present.nextSlide")}
              disabled={index >= slides.length - 1}
              onClick={() => go(index + 1)}
            />
            {wide && (
              <Button size="sm" variant="ghost" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)}>
                {t("live.slides.notes.short")}
              </Button>
            )}
          </>
        )}
        <Button size="sm" variant="ghost" icon="close" onClick={onExit}>
          {t("live.slides.present.exit")}
        </Button>
      </div>
    </div>
  );
}
