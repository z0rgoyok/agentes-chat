import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8").replace(/\s+/g, " ");

test("a picture already in the phone's image cache is drawn from there, with no request for a link", () => {
  const source = src("features/files/source.ts");
  expect(source).toContain("const askServer = local || fromServer || (disk.isFetched && !disk.data);");
  expect(source).toContain("const link = useRemoteFile(orgId, askServer ? id : null, version);");
  expect(source).toContain("await Image.getCachePathAsync(key)");
  // A copy the system removed meanwhile: the link, as before.
  expect(source).toContain("onError: () => (cached ? setFromServer(true) : setFailed(true)),");
});

test("every picture tile reads its picture that way, under one cache key per version", () => {
  for (const file of [
    "features/files/MessageFiles.tsx",
    "features/files/AttachmentTile.tsx",
    "features/drive/DriveCard.tsx",
  ])
    expect({ file, uses: src(file).includes("usePicture(") }).toEqual({ file, uses: true });
  const source = src("features/files/source.ts");
  expect(source).toContain("export const pictureKey = (id: string, version?: number) =>");
  expect(source).toContain('export const diskUri = (path: string) => (path.startsWith("/") ?');
});
