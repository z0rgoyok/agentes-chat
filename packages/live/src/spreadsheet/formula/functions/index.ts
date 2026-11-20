/**
 * Every spreadsheet function the engine knows (ADR 0196 §2), by canonical (English) name. A name not here evaluates to
 * `#NAME?`, keeping the formula as written, so a file from Excel with a function we lack round-trips unchanged.
 */
import { DATETIME } from "./datetime";
import { FINANCE } from "./finance";
import { INFO } from "./info";
import { LOGIC } from "./logic";
import { LOOKUP } from "./lookup";
import { MATH } from "./math";
import type { FnSpec } from "./spec";
import { STATS } from "./stats";
import { TEXT } from "./text";

export const FUNCTIONS: Readonly<Record<string, FnSpec>> = Object.freeze({
  ...MATH,
  ...STATS,
  ...LOGIC,
  ...LOOKUP,
  ...TEXT,
  ...DATETIME,
  ...INFO,
  ...FINANCE,
});

export type { FnSpec } from "./spec";
