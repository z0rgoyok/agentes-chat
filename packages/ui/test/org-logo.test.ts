import { expect, test } from "bun:test";
import { hasLightInk, LIGHT_INK, LOGO_PLATES, logoPlate } from "../src/org-logo";

test("a logo's plate shows only where the theme's surface would hide its ink", () => {
  const dark = "/api/app/org-logos/o1/0123456789abcdef.png";
  const light = `${dark}${LIGHT_INK}`;
  expect(hasLightInk(light)).toBe(true);
  expect(hasLightInk(dark)).toBe(false);
  expect(hasLightInk(null)).toBe(false);
  expect(logoPlate(dark, false)).toBeNull();
  expect(logoPlate(dark, true)).toBe(LOGO_PLATES.darkInk);
  expect(logoPlate(light, false)).toBe(LOGO_PLATES.lightInk);
  expect(logoPlate(light, true)).toBeNull();
});
