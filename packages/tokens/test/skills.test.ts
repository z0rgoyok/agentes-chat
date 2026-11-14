import { expect, test } from "bun:test";
import { SKILL_ASSET_BYTES, SKILL_TEXT_BYTES, SKILL_ZIP_BASE64_CHARS, SKILL_ZIP_BYTES } from "../src/skills";

test("the largest .zip the apps send is the largest whose base64 the import takes", () => {
  const base64 = (bytes: number) => 4 * Math.ceil(bytes / 3);
  expect(base64(SKILL_ZIP_BYTES)).toBeLessThanOrEqual(SKILL_ZIP_BASE64_CHARS);
  expect(base64(SKILL_ZIP_BYTES + 1)).toBeGreaterThan(SKILL_ZIP_BASE64_CHARS);
  // Room for everything a skill keeps, stored uncompressed.
  expect(SKILL_ZIP_BYTES).toBeGreaterThan(SKILL_TEXT_BYTES + SKILL_ASSET_BYTES);
});
