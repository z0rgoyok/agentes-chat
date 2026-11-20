import { radius } from "@agenteschat/tokens";

/**
 * The phone's corner radii: the design system's scale (`@agenteschat/tokens`, the web's `--radius-*`), so a corner here
 * is one the web draws too: `sm` (6) the cards' cut corner and a run's joined one, `xl` (18) a conversation's bubbles and
 * the cards in its messages, `section` (20) the app's raised cards (`Card`). Pure (no React Native import), so tests
 * read it.
 */
export const RADIUS = radius;

/**
 * A shape with its four corners named (top left, top right, bottom right, bottom left). React Native draws a corner's
 * own radius over `borderRadius` whatever comes later in the style, so a shape that leaves one corner to
 * `borderRadius` keeps whatever corner an earlier style named: every shape names all four.
 */
export function corners(topLeft: number, topRight: number, bottomRight: number, bottomLeft: number): Corners {
  return {
    borderTopLeftRadius: topLeft,
    borderTopRightRadius: topRight,
    borderBottomRightRadius: bottomRight,
    borderBottomLeftRadius: bottomLeft,
  };
}

export interface Corners {
  readonly borderTopLeftRadius: number;
  readonly borderTopRightRadius: number;
  readonly borderBottomRightRadius: number;
  readonly borderBottomLeftRadius: number;
}

/** The corners of what sits `inset` inside a shape, concentric with it (never quite square). */
export function insetCorners(shape: Corners, inset: number): Corners {
  return corners(
    Math.max(1, shape.borderTopLeftRadius - inset),
    Math.max(1, shape.borderTopRightRadius - inset),
    Math.max(1, shape.borderBottomRightRadius - inset),
    Math.max(1, shape.borderBottomLeftRadius - inset),
  );
}
