import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");

test("photos and workspace marks load through expo-image, cached, with no fade", () => {
  for (const file of ["agent/PersonAvatar.tsx", "features/shared/OrgAvatar.tsx"]) {
    const face = src(file);
    for (const piece of [
      'import { Image } from "expo-image";',
      'cachePolicy="memory-disk"',
      "recyclingKey=",
      "transition={0}",
    ])
      expect({ file, piece, there: face.includes(piece) }).toEqual({ file, piece, there: true });
    expect({ file, rn: /import \{[^}]*\bImage\b[^}]*\} from "react-native"/.test(face) }).toEqual({
      file,
      rn: false,
    });
  }
  // The backend's photos still go with the session's headers.
  expect(src("features/shared/OrgAvatar.tsx")).toContain("photoSource(logo, serverOf(on), appHeaders(lastCookie(on)))");
});

test("the lists' times are written with formats made once per language", () => {
  const hooks = src("features/shared/hooks.ts");
  const when = hooks.slice(hooks.indexOf("export function useWhen()"), hooks.indexOf("export function useNow("));
  expect(when).not.toContain("new Intl.DateTimeFormat");
  expect(when).toContain("const formats = whenFormatsOf(locale);");
  expect(hooks).toContain("const whenFormats = new Map<string, WhenFormats>();");
});

test("a section's title reads as every section header: Section draws a SectionHeader", () => {
  const section = src("ui/Section.tsx");
  expect(section).toContain("<SectionHeader title={title}");
  expect(section).not.toContain('variant="label"');
  expect(section).toContain("body: { paddingHorizontal: SCREEN_X }");
});
