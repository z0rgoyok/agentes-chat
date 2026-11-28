import { useRef } from "react";

/**
 * The ids a list gained after it first loaded, each with its place among them (a team's channels and agents landing
 * in the sidebar): their rows carry `data-arriving` and open their room instead of pushing the rest down at once.
 * Nothing counts as new before `ready`.
 */
export function useArrived(ids: readonly string[], ready: boolean): ReadonlyMap<string, number> {
  const first = useRef<ReadonlySet<string> | null>(null);
  if (!first.current && ready) first.current = new Set(ids);
  const seen = first.current;
  const arrived = new Map<string, number>();
  if (seen) for (const id of ids) if (!seen.has(id)) arrived.set(id, arrived.size);
  return arrived;
}
