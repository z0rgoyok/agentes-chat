import { useState } from "react";

/**
 * True from the first render `flag` is, for good: a dialog whose code comes when it first opens (`lazy`) stays mounted
 * after that, so it closes with its own animation instead of vanishing.
 */
export function useEverTrue(flag: boolean): boolean {
  const [ever, setEver] = useState(flag);
  if (flag && !ever) setEver(true);
  return ever || flag;
}
