/**
 * The picture viewer's numbers and the math behind its gestures (`ImageViewer`, `ZoomPicture`): pure, so it runs on
 * the UI thread (each function is a worklet) and in tests.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A double tap zooms in at least this far, or as far as it takes for the picture to fill the screen. */
export const DOUBLE_TAP_ZOOM = 2;
/** Zooming stops at twice the picture's own pixels (past its sharpness, never mush), and never past 10×. */
const PIXELS_ZOOM = 2;
const ZOOM_CAP = 10;
/** A pull closes the viewer when it would come to rest at least this far away (in points)… */
export const DISMISS_DISTANCE = 100;
/** …or this share of the screen's height, on a tall screen. */
export const DISMISS_SHARE = 0.15;
/**
 * How far a let-go pull carries on, in seconds of its speed: where it would come to rest, as a scroll view's fast
 * deceleration throws it. A flick adds real distance, a slow release barely any, so speed alone never closes it.
 */
export const PULL_PROJECTION = 0.1;
/** Pulled half a screen away, the picture is this small. */
export const DISMISS_MIN_SCALE = 0.75;
/** How closely the picture follows the finger sideways at the start of a pull; then less and less, as a scroll's edge. */
const FOLLOW = 0.8;
/** How a zoomed picture resists past its edges, and a pinch past 1× or its most: a scroll view's own rubber band. */
export const EDGE_RESISTANCE = 0.55;
/** Past 1× or the most it zooms, a pinch gives at most this share of that zoom more, resisting all the way. */
export const ZOOM_GIVE = 0.25;

export function clamp(value: number, min: number, max: number): number {
  "worklet";
  return Math.min(Math.max(value, min), max);
}

/** How far a picture may zoom in: `pixelWidth` is its own width in pixels (unknown until it loads). */
export function maxZoom(pixelWidth: number | undefined, screenWidth: number): number {
  "worklet";
  if (!pixelWidth || screenWidth <= 0) return DOUBLE_TAP_ZOOM;
  return clamp((pixelWidth / screenWidth) * PIXELS_ZOOM, DOUBLE_TAP_ZOOM, ZOOM_CAP);
}

/** The picture whole on the screen at 1×: as wide as the screen or as tall, its own shape kept. */
export function fitted(aspect: number | null, screen: Size): Size {
  "worklet";
  if (!aspect || !Number.isFinite(aspect)) return screen;
  return aspect > screen.width / screen.height
    ? { width: screen.width, height: screen.width / aspect }
    : { width: screen.height * aspect, height: screen.height };
}

/** The zoom a double tap goes to: enough to fill the screen (no black bars), at least `DOUBLE_TAP_ZOOM`, at most `max`. */
export function doubleTapZoom(picture: Size, screen: Size, max: number): number {
  "worklet";
  const fill = Math.max(screen.width / picture.width, screen.height / picture.height);
  return Math.min(max, Math.max(DOUBLE_TAP_ZOOM, fill));
}

/**
 * Where a double tap at `at` (a point on the screen) zooms in, for iOS's own zoom: the part of the picture to show, in
 * the picture's points at 1× (it sits centered there). The tapped spot stays under the finger; on an axis where the
 * zoomed picture still doesn't fill the screen, it stays centered.
 */
export function zoomInRect(picture: Size, screen: Size, at: Point, max: number): Size & Point {
  "worklet";
  const zoom = doubleTapZoom(picture, screen, max);
  const width = screen.width / zoom;
  const height = screen.height / zoom;
  const spotX = at.x - (screen.width - picture.width) / 2;
  const spotY = at.y - (screen.height - picture.height) / 2;
  const x = picture.width <= width ? (picture.width - width) / 2 : clamp(spotX - at.x / zoom, 0, picture.width - width);
  const y =
    picture.height <= height ? (picture.height - height) / 2 : clamp(spotY - at.y / zoom, 0, picture.height - height);
  return { x, y, width, height };
}

/** How far a picture zoomed to `scale` may move each way and still cover the screen (0 on an axis where it fits). */
export function panRoom(picture: Size, scale: number, screen: Size): Point {
  "worklet";
  return {
    x: Math.max(0, (picture.width * scale - screen.width) / 2),
    y: Math.max(0, (picture.height * scale - screen.height) / 2),
  };
}

/**
 * Where a double tap at `focal` (from the screen's center) leaves a picture at 1× zoomed in, for Android's zoom of
 * ours: the tapped spot under the finger, the picture still over the whole screen.
 */
export function zoomInAt(picture: Size, screen: Size, focal: Point, max: number): { scale: number } & Point {
  "worklet";
  const scale = doubleTapZoom(picture, screen, max);
  const room = panRoom(picture, scale, screen);
  return {
    scale,
    x: clamp(focal.x * (1 - scale), -room.x, room.x),
    y: clamp(focal.y * (1 - scale), -room.y, room.y),
  };
}

/**
 * Damps a drag past an edge: it starts at `follow` times the finger and tapers off, never reaching `limit` (a scroll
 * view's edge has the same feel).
 */
export function rubberBand(distance: number, limit: number, follow: number): number {
  "worklet";
  if (limit <= 0) return 0;
  const damped = (1 - 1 / ((Math.abs(distance) * follow) / limit + 1)) * limit;
  return Math.sign(distance) * damped;
}

/** `rubberBand` undone: how far the finger went for a damped distance. */
export function unRubberBand(damped: number, limit: number, follow: number): number {
  "worklet";
  if (limit <= 0 || follow <= 0) return 0;
  const part = Math.min(Math.abs(damped) / limit, 0.999);
  return (Math.sign(damped) * part * limit) / (follow * (1 - part));
}

/**
 * Where a position past `min` or `max` shows: inside, as it is; past an edge it gives, resisting more and more, never
 * further than `limit` (a scroll view's edge). On an axis with no room (`max` = `min`) it doesn't move at all, as a
 * scroll view whose content fits doesn't bounce that way.
 */
export function rubberClamp(value: number, min: number, max: number, limit: number): number {
  "worklet";
  if (max <= min) return min;
  if (value > max) return max + rubberBand(value - max, limit, EDGE_RESISTANCE);
  if (value < min) return min + rubberBand(value - min, limit, EDGE_RESISTANCE);
  return value;
}

/**
 * A drag's next position, moved by `change` from `position` (which may already be past an edge): the finger's own
 * travel inside `min`…`max`, resisted past them (`rubberClamp`). It works from where the finger would be without the
 * resistance, so a drag back in comes out of the stretch at the rate it went in.
 */
export function dragWithin(position: number, change: number, min: number, max: number, limit: number): number {
  "worklet";
  if (max <= min) return min;
  let free = position;
  if (position > max) free = max + unRubberBand(position - max, limit, EDGE_RESISTANCE);
  else if (position < min) free = min + unRubberBand(position - min, limit, EDGE_RESISTANCE);
  return rubberClamp(free + change, min, max, limit);
}

/** A pinch's zoom past `min` (1×) or `max`: a little more (`ZOOM_GIVE`), resisting all the way; it springs back after. */
export function resistedZoom(scale: number, min: number, max: number): number {
  "worklet";
  if (scale > max) return max + rubberBand(scale - max, max * ZOOM_GIVE, EDGE_RESISTANCE);
  if (scale < min) return min + rubberBand(scale - min, min * ZOOM_GIVE, EDGE_RESISTANCE);
  return scale;
}

/**
 * Where a pinch let go comes to rest: its zoom back inside 1×…`max` around the spot between the fingers (`focal`, from
 * the screen's center), the picture back over the whole screen.
 */
export function pinchRest(
  picture: Size,
  screen: Size,
  at: { scale: number } & Point,
  focal: Point,
  max: number,
): { scale: number } & Point {
  "worklet";
  const scale = clamp(at.scale, 1, max);
  const grown = scale / at.scale;
  const room = panRoom(picture, scale, screen);
  return {
    scale,
    x: clamp(focal.x - grown * (focal.x - at.x), -room.x, room.x),
    y: clamp(focal.y - grown * (focal.y - at.y), -room.y, room.y),
  };
}

/** Where a pull let go would come to rest: its travel and the way its speed carries it (`PULL_PROJECTION`). */
export function pullProjection(travel: number, velocity: number): number {
  "worklet";
  return travel + velocity * PULL_PROJECTION;
}

/**
 * Whether letting go of a pull closes the viewer: it would come to rest far enough away, either way
 * (`pullProjection`). So a flick closes from a short pull, a slow release only past the distance, and one flung back
 * toward the middle stays.
 */
export function pullCloses(travel: number, velocity: number, screenHeight: number): boolean {
  "worklet";
  return Math.abs(pullProjection(travel, velocity)) > Math.max(DISMISS_DISTANCE, screenHeight * DISMISS_SHARE);
}

/** Which way a closing pull leaves: toward where it would come to rest. */
export function pullDirection(travel: number, velocity: number): 1 | -1 {
  "worklet";
  return pullProjection(travel, velocity) < 0 ? -1 : 1;
}

/** The speed a closing picture leaves with: its own, never back toward the middle (then it starts from still). */
export function awaySpeed(direction: 1 | -1, velocity: number): number {
  "worklet";
  return direction > 0 ? Math.max(velocity, 0) : Math.min(velocity, 0);
}

/** A pull's progress, 0 at rest to 1 half a screen away: the black fades and the picture shrinks with it. */
export function pullProgress(translationY: number, screenHeight: number): number {
  "worklet";
  return Math.min(Math.abs(translationY) / (screenHeight / 2), 1);
}

/**
 * Where the picture sits for a pull of the finger (`travelX`, `travelY`): up and down exactly with it, sideways more
 * loosely, a little smaller as it goes. It shrinks around the spot the finger took (`grab`, from the picture's
 * center), so that spot stays under the finger instead of sliding toward the middle.
 */
export function pulledPlacement(
  travelX: number,
  travelY: number,
  screen: Size,
  grab: Point,
): Point & { scale: number } {
  "worklet";
  const scale = 1 - (1 - DISMISS_MIN_SCALE) * pullProgress(travelY, screen.height);
  return {
    x: rubberBand(travelX, screen.width / 2, FOLLOW) + grab.x * (1 - scale),
    y: travelY + grab.y * (1 - scale),
    scale,
  };
}
