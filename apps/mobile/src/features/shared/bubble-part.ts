import { createContext, type ReactNode, useContext } from "react";
import type { ViewStyle } from "react-native";
import { corners, RADIUS } from "@/ui/radius";

/**
 * A card under someone else's words in a conversation of bubbles: it is a bubble of the same message, so it takes the
 * bubble's fill (and its light edge over a background) instead of the raised surface and its shadow (`useSurface`),
 * and joins the bubble group above it. Null elsewhere (a conversation of lines, my own row, Atividade, Início).
 */
export interface BubblePart {
  fill: string;
  edge: ViewStyle | null;
}
export const BubblePartContext = createContext<BubblePart | null>(null);
export const useBubblePart = () => useContext(BubblePartContext);

/**
 * A card in a message (its tools, what it changed, a request, a file, its work, a proposal): the bubbles' 18 with the
 * cards' cut corner (6) at the bottom left. One shape for every card in a conversation, whatever its own elsewhere.
 */
export const MESSAGE_CARD_CORNERS = corners(RADIUS.xl, RADIUS.xl, RADIUS.xl, RADIUS.sm);

/**
 * A card's corners in a bubble group: the bubbles' 18, its top left close to what is above it (a run's 6), its bottom
 * left cut (the cards' own corner). As the web's (`looks.css`).
 */
export const BUBBLE_PART_CORNERS = corners(RADIUS.sm, RADIUS.xl, RADIUS.xl, RADIUS.sm);

/**
 * A message with no words whose one card is a request (an approval, a question, a secret): in bubbles its name line
 * goes inside the card, at its top, and its time at the card's end, as a bubble's. Null elsewhere.
 */
export interface BubbleHead {
  who: ReactNode;
  time: string;
}
export const BubbleHeadContext = createContext<BubbleHead | null>(null);
export const useBubbleHead = () => useContext(BubbleHeadContext);
