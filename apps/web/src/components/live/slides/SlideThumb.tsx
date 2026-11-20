import { SLIDE_H, SLIDE_W, type SlideTheme, type SlideView, type ThemeId } from "@agenteschat/live/slides";
import { cx } from "@agenteschat/ui";
import { memo } from "react";
import { Scaled, SlideBody, SlideImages, type SlideImageUrl, themeFrom } from "./render";

/**
 * A slide drawn small (ADR 0196 §2): the rail's thumbnails, the Drive's and the chat's covers of a presentation, the
 * layout picker. It is the slide itself scaled down, never a picture of it, so it is always current. Pictures need
 * their addresses: inside the editor they come from it; a cover passes `imageUrl` (else a picture shows as its frame).
 */
export const SlideThumb = memo(function SlideThumb({
  slide,
  theme,
  width,
  deck,
  imageUrl,
  className,
}: {
  slide: SlideView;
  theme: ThemeId | SlideTheme;
  /** Page pixels wide; the height follows the deck's shape. */
  width: number;
  /** The deck's size in slide units (1920×1080 for a live file). */
  deck?: { w: number; h: number };
  imageUrl?: SlideImageUrl;
  className?: string;
}) {
  const w = deck?.w ?? SLIDE_W;
  const h = deck?.h ?? SLIDE_H;
  const body = (
    <Scaled scale={width / w} w={w} h={h} className={cx("sl-thumb", className)}>
      <SlideBody slide={slide} theme={themeFrom(theme)} mode="thumb" w={w} h={h} />
    </Scaled>
  );
  return imageUrl ? <SlideImages.Provider value={imageUrl}>{body}</SlideImages.Provider> : body;
});
