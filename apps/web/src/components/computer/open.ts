import type { Seat } from "@agenteschat/client/lib/seat";
import { createContext, useContext } from "react";

/**
 * Opens an agent's computer in the workspace's one dialog (`ComputerDialogProvider`). `seat`: the right hand's shared
 * place on the workspace's computer instead of the viewer's own (ADR 0175).
 */
export type OpenComputer = (agentId: string, seat?: Seat) => void;
export const OpenComputerContext = createContext<OpenComputer | null>(null);

const noop = () => {};

/** Opens an agent's computer in place; does nothing outside a workspace's pages. */
export const useOpenComputer = (): OpenComputer => useContext(OpenComputerContext) ?? noop;

/**
 * The agent whose computer the dialog shows now, or null: a card behind it leaves the screen to the dialog's own
 * view (ADR 0058 §7), so one person never holds two streams of one screen.
 */
export const OpenedComputerContext = createContext<string | null>(null);

export const useOpenedComputer = (): string | null => useContext(OpenedComputerContext);
