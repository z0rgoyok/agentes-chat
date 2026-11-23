import type {
  DeckData,
  DeckView as DeckViewData,
  ElementView,
  SlideLayout,
  SlideView,
  ThemeId,
} from "@agenteschat/live/slides";
import { isSlideLayout, isThemeId } from "@agenteschat/live/slides";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { objectUrls } from "@/components/artifacts/FileView";
import { Scaled, SlideBody, SlideImages, type SlideImageUrl, themeFrom } from "./render";
import { useBoxSize } from "./useBoxSize";

/**
 * A presentation to look at, not to edit (ADR 0198): an uploaded `.pptx` as its preview reads it (`DeckData`), or a
 * live file's deck (`DeckView`, a version, a file in the trash). Slides one under another at the width of the room,
 * numbered, hidden ones marked, as a long document reads; each is drawn only once it comes near the screen.
 */
export function DeckView({ deck }: { deck: DeckViewData | DeckData }) {
  const { t } = useTranslation();
  const { view, url } = useDeckOf(deck);
  const [box, size] = useBoxSize<HTMLElement>();
  const width = Math.max(200, Math.min(1200, (size.w || 960) - 48));
  return (
    <SlideImages.Provider value={url}>
      <section ref={box} className="sl-deck" aria-label={t("live.slides.deck.label", { count: view.slides.length })}>
        {view.slides.map((slide) => (
          <figure key={slide.id} className="sl-deck__slide" data-hidden={slide.hidden ? "true" : undefined}>
            <figcaption className="sl-deck__number tabular">
              {slide.hidden
                ? t("live.slides.deck.hiddenNumber", { n: slide.index + 1 })
                : t("live.slides.deck.number", { n: slide.index + 1 })}
            </figcaption>
            <LazySlide slide={slide} theme={view.theme} w={view.w} h={view.h} width={width} />
          </figure>
        ))}
      </section>
    </SlideImages.Provider>
  );
}

function LazySlide({
  slide,
  theme,
  w,
  h,
  width,
}: {
  slide: SlideView;
  theme: ThemeId;
  w: number;
  h: number;
  width: number;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  const scale = width / w;
  return (
    <div ref={setEl} className="sl-deck__frame" style={{ width: w * scale, height: h * scale } as CSSProperties}>
      {seen && (
        <Scaled scale={scale} w={w} h={h}>
          <SlideBody slide={slide} theme={themeFrom(theme)} mode="show" w={w} h={h} />
        </Scaled>
      )}
    </div>
  );
}

/** A deck as the slides' drawing reads it, and where its pictures are. */
function useDeckOf(deck: DeckViewData | DeckData): { view: DeckViewData; url: SlideImageUrl } {
  const data = "media" in deck ? deck : null;
  const view = useMemo(() => (data ? deckViewOf(data) : (deck as DeckViewData)), [data, deck]);
  // Pictures that came as bytes get addresses of their own while shown.
  const [made, setMade] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!data) return;
    const urls = new Map<string, string>();
    for (const [name, media] of Object.entries(data.media)) {
      if (!media.url && media.bytes) {
        const url = objectUrls.create(new Blob([media.bytes as BlobPart], { type: media.type || "image/png" }));
        if (url) urls.set(name, url);
      }
    }
    setMade(urls);
    return () => {
      for (const url of urls.values()) objectUrls.revoke(url);
    };
  }, [data]);
  const url = useMemo<SlideImageUrl>(
    () => (id) => (data ? (data.media[id]?.url ?? made.get(id) ?? null) : null),
    [data, made],
  );
  return { view, url };
}

/** An uploaded deck as slides: elements get ids by their place, pictures go by their name in `media`. */
export function deckViewOf(data: DeckData): DeckViewData {
  const theme: ThemeId = isThemeId(data.theme) ? data.theme : "sky";
  return {
    theme,
    w: data.w > 0 ? data.w : 1920,
    h: data.h > 0 ? data.h : 1080,
    slides: data.slides.map((s, index): SlideView => {
      const layout: SlideLayout = isSlideLayout(s.layout) ? s.layout : "blank";
      const view: SlideView = {
        id: `s${index}`,
        index,
        layout,
        notes: s.notes ?? "",
        elements: s.elements.map((e, j): ElementView => {
          const el: ElementView = {
            id: `e${j}`,
            type: e.type,
            x: e.x,
            y: e.y,
            w: e.w,
            h: e.h,
            z: String(j).padStart(5, "0"),
          };
          if (e.rot) el.rot = e.rot;
          if (e.role) el.role = e.role;
          if (e.text) el.text = e.text;
          if (e.style) el.style = e.style;
          if (e.media) el.asset = e.media;
          if (e.type === "image") el.fit = e.fit ?? "contain";
          if (e.alt) el.alt = e.alt;
          if (e.table) el.table = e.table;
          if (e.chart) el.chart = e.chart;
          return el;
        }),
      };
      if (typeof s.bg === "string") view.bg = s.bg;
      else if (s.bg && typeof s.bg === "object") view.bg = { asset: s.bg.media };
      if (s.hidden) view.hidden = true;
      return view;
    }),
  };
}
