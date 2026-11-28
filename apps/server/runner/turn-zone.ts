/**
 * The env a turn's CLI runs with for the turn's zone (`BrainTurnRequest.timeZone`): `TZ`, so the date its system
 * prompt states and every `date` its shell runs fall on the person's day. The computer's own zone follows its egress
 * (where its browser's sites see it), which can be a day ahead of the person or behind. An unknown zone sets nothing.
 */
export function turnZoneEnv(zone: unknown): Record<string, string> {
  if (typeof zone !== "string" || zone.length > 64 || !/^[A-Za-z][\w+/-]*$/.test(zone)) return {};
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    return {};
  }
  return { TZ: zone };
}
