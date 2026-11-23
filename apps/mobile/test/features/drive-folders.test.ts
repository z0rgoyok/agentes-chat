import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "../..", path), "utf8");

describe("the phone's Drive folders", () => {
  test("a folder is its own screen: the route passes it, the screen lists its folders, its path and its files", () => {
    expect(read("app/(app)/(main)/drive/index.tsx")).toContain("folderId={isSafeId(folder) ? folder : null}");
    const screen = read("src/features/drive/DriveScreen.tsx");
    expect(screen).toContain("{here ? <FolderPath trail={trail} /> : null}");
    expect(screen).toContain(
      "<FolderRows folders={subfolders} onMenu={(f) => arrange.folderMenu(f, mayUpload)} more={mayUpload} />",
    );
    expect(screen).toContain('title={t("drive.folderEmptyTitle")}');
    // Uploads land in the folder shown.
    expect(screen).toContain("useDriveUpload(list.refetch, folderId)");
  });

  test("a long press on a file or a folder opens its actions, as the web's right click", () => {
    const screen = read("src/features/drive/DriveScreen.tsx");
    expect(screen).toContain("onPress: () => arrange.newFolder(folderId)");
    expect(screen).toContain("useLatest((x: Artifact, open: () => void) => arrange.fileMenu(x, open, mayUpload))");
    expect(screen).toContain("onLongPress={fileMenu}");
    const folders = read("src/features/drive/folders.tsx");
    expect(folders).toContain("onLongPress={() => onMenu(f)}");
    for (const label of ["artifacts.openFile", "mobile.files.sendCopy", "drive.rename", "drive.moveToMenu"]) {
      expect(folders).toContain(`label: t("${label}")`);
    }
    expect(folders).toContain('label: t("artifacts.delete")');
    expect(folders).toContain('label: t("drive.openFolder")');
    expect(folders).toContain("folderAndInside(all, movingFolder)");
  });

  test("the move picker is a tree: a guide line per level, no path line", () => {
    const folders = read("src/features/drive/folders.tsx");
    expect(folders).toContain("depth: depth + 1,");
    expect(folders).not.toContain('sub: [t("drive.title")');
    const grouped = read("src/ui/Grouped.tsx");
    expect(grouped).toContain("left: TREE_X + i * NEST");
    // A long name wraps, its tile on the first line at every depth.
    expect(read("src/features/shared/PickerSheet.tsx")).toContain("{ depth: o.depth, labelLines: 0 }");
    expect(grouped).toContain("<View style={[styles.lead, tileOnLine]}>");
  });
});
