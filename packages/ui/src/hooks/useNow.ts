import { useEffect, useState } from "react";

/**
 * The time now, moving on every `every` ms (a countdown, the minutes a request has left); `false`: still. A
 * function picks the pace from the time it last read (a countdown repaints faster near its end). While the page is
 * hidden it doesn't move (nothing would be drawn), and it reads the time again once the page shows.
 */
export function useNow(every: number | false | ((now: number) => number | false)) {
  const [now, setNow] = useState(() => Date.now());
  const ms = typeof every === "function" ? every(now) : every;
  useEffect(() => {
    if (ms === false) return;
    const tick = () => {
      if (!document.hidden) setNow(Date.now());
    };
    tick();
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
  return now;
}
