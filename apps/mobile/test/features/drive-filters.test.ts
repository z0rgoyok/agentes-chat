import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact } from "@agenteschat/client";
import {
  DRIVE_TYPES,
  driveFilters,
  driveKinds,
  driveView,
  keepsLooking,
  matchesType,
} from "../../src/features/drive/logic";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const item = (kind: Artifact["kind"], title: string) => ({ kind, title });

describe("the Drive's type chips", () => {
  test("each chip narrows the list on the server to the kinds that can hold its type", () => {
    expect(driveKinds("all")).toBeUndefined();
    expect(driveKinds("documents")).toEqual(["document", "file"]);
    expect(driveKinds("images")).toEqual(["file"]);
    expect(driveKinds("tables")).toEqual(["table", "file"]);
    expect(driveKinds("diffs")).toEqual(["diff"]);
    expect(driveFilters("", "all")).toEqual({});
    expect(driveFilters("plano", "all")).toEqual({ q: "plano" });
    expect(driveFilters("plano", "documents")).toEqual({ q: "plano", kinds: ["document", "file"] });
  });

  test("whatever the server sends for a chip, the phone keeps only the files its name says are of the type", () => {
    for (const type of DRIVE_TYPES) {
      const kinds = driveKinds(type);
      // Every match is of a kind the server was asked for.
      for (const a of [
        item("document", "Plano"),
        item("table", "Vendas"),
        item("diff", "Ajuste"),
        item("file", "notas.md"),
        item("file", "foto.png"),
        item("file", "planilha.csv"),
      ])
        if (matchesType(a, type))
          expect({ type, a, ok: !kinds || kinds.includes(a.kind) }).toEqual({ type, a, ok: true });
    }
    expect(matchesType(item("file", "foto.png"), "documents")).toBe(false);
    expect(matchesType(item("file", "foto.png"), "images")).toBe(true);
  });

  test("past the pages read, the next one comes by itself until a page of matches or none left, never twice at once", () => {
    const at = { matched: 3, wanted: 24, hasNextPage: true, fetching: false, placeholder: false, failed: false };
    expect(keepsLooking(at)).toBe(true);
    expect(keepsLooking({ ...at, matched: 24 })).toBe(false);
    expect(keepsLooking({ ...at, hasNextPage: false })).toBe(false);
    expect(keepsLooking({ ...at, fetching: true })).toBe(false);
    // The last filter's list, shown while the new one loads, says nothing about the new one's pages.
    expect(keepsLooking({ ...at, placeholder: true })).toBe(false);
    // A page that failed waits for the person: asking again at once would never stop.
    expect(keepsLooking({ ...at, failed: true })).toBe(false);
  });

  test("a chip with nothing found yet shows the rows' shape while it looks, then says nothing matched", () => {
    const at = { loading: false, failed: false, matched: 0, hasNextPage: true, placeholder: false, filtered: true };
    expect(driveView(at)).toBe("loading");
    expect(driveView({ ...at, hasNextPage: false, placeholder: true })).toBe("loading");
    expect(driveView({ ...at, hasNextPage: false })).toBe("noMatch");
    expect(driveView({ ...at, hasNextPage: false, filtered: false })).toBe("empty");
    expect(driveView({ ...at, matched: 2 })).toBe("grid");
    expect(driveView({ ...at, loading: true })).toBe("loading");
    expect(driveView({ ...at, failed: true })).toBe("failed");
  });

  test("the screen asks the server with the chip, refines on the phone, and says why when nothing matches", () => {
    const screen = src("features/drive/DriveScreen.tsx");
    // Browsing a folder adds it; a search or a chip looks through the whole Drive.
    expect(screen).toContain("() => ({ ...driveFilters(search, type), ...(browsing ? { folderId } : {}) }),");
    expect(screen).toContain('const browsing = search === "" && type === "all";');
    expect(screen).toContain("(list.artifacts ?? []).filter((a) => matchesType(a, type))");
    expect(screen).toContain("failed: list.isFetchNextPageError,");
    expect(screen).toContain('view === "loading" ? (');
    expect(screen).toContain("<LoadFailed");
    expect(screen).toContain('label={t("filters.clearAll")} onPress={clear}');
  });

  test("Mostrar mais sits in the middle of the screen, inside its margins", () => {
    const screen = src("features/drive/DriveScreen.tsx");
    expect(screen).toContain(
      'more: { flexDirection: "row", justifyContent: "center", paddingHorizontal: SCREEN_X, paddingTop: 20 },',
    );
    expect(screen).not.toContain("paddingHorizontal: 16");
  });

  test("every other show-more and retry button here is centred by a row of its own, never by the column's alignment", () => {
    // A button keeps to its own width at its row's start (`alignSelf: "flex-start"`), whatever its column centres.
    for (const file of ["features/blocks/LiveBlock.tsx", "features/blocks/SpecBlock.tsx"])
      expect({
        file,
        more: src(file).includes('more: { flexDirection: "row", justifyContent: "center", paddingBottom: 8 },'),
      }).toEqual({
        file,
        more: true,
      });
    const zoom = src("features/files/ZoomPicture.tsx");
    expect(zoom).toMatch(
      /<View style=\{styles\.retry\}>\s*<Button\s+variant="secondary"\s+size="sm"\s+label=\{t\("mobile\.common\.retry"\)\}/,
    );
    expect(zoom).toContain('retry: { flexDirection: "row" },');
  });
});
