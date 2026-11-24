import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("presses in the files, the blocks and the Drive are the kit's", () => {
  test("a file, a picture or a video opened from a message or the Drive gives under the finger, with no tap", () => {
    for (const file of [
      "features/files/AttachmentTile.tsx",
      "features/files/MessageFiles.tsx",
      "features/files/VideoPlayer.tsx",
      "features/drive/DriveCard.tsx",
    ]) {
      const s = src(file);
      expect({ file, kit: s.includes("<PressScale") && s.includes("haptic={false}") }).toEqual({ file, kit: true });
      // No pressed look of its own, no haptic added by hand on navigation.
      expect({ file, own: /pressed && styles\.pressed|tapHaptic\(\)/.test(s) }).toEqual({ file, own: false });
    }
  });

  test("a vote's and a choice's options press as the kit does; the choice card's buttons are the kit's buttons", () => {
    for (const file of ["features/blocks/PollCard.tsx", "features/blocks/ChoicesCard.tsx"]) {
      const s = src(file);
      expect({ file, kit: s.includes("<PressScale") }).toEqual({ file, kit: true });
      expect({ file, own: s.includes("<Pressable") || s.includes("tapHaptic") }).toEqual({ file, own: false });
    }
    const choices = src("features/blocks/ChoicesCard.tsx");
    expect(choices).toContain('<IconButton icon="x" label={t("mobile.choices.close")}');
    expect(choices).toMatch(/<Button\s+variant="ghost"\s+size="sm"\s+label=\{t\("mobile\.choices\.back"\)\}/);
    expect(choices).toMatch(/<Button\s+variant="ghost"\s+size="sm"\s+label=\{t\("mobile\.choices\.next"\)\}/);
  });

  test("a block's buttons give one tap each (the kit's), its disclosure is a button with a chevron", () => {
    for (const file of ["features/blocks/SpecBlock.tsx", "features/blocks/LiveBlock.tsx"])
      expect({ file, double: src(file).includes("tapHaptic") }).toEqual({ file, double: false });
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).not.toContain("▸");
    expect(spec).toContain('icon={open ? "chev" : "right"}');
    // A drawn value comes in on the app's ease-out, no bounce; the success tap only on the phone of who drew it.
    expect(spec).toContain("if (change?.by === meId) haptics.success();");
    expect(spec).not.toContain("withSpring(0, { stiffness: 260, damping: 14 })");
  });

  test("a block's field is the app's text field, never one drawn by the block", () => {
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).toContain("<TextArea");
    expect(spec).not.toContain("<TextInput");
  });

  test("a deck of pictures let go of settles on the app's snap", () => {
    const stack = src("features/files/ImageStack.tsx");
    expect(stack).toContain("const SETTLE = { ...motion.snap };");
    expect(stack).not.toContain("stiffness: 190");
  });
});

describe("the Vault's screens", () => {
  test("New item is the bar's +, so the tabs never move when another tab shows", () => {
    const vault = src("features/vault/VaultScreen.tsx");
    expect(vault).toContain(
      'actions: [{ icon: "plus", sf: "plus", label: t("mobile.vault.newItem"), onPress: create }]',
    );
    expect(vault).not.toContain("tabEmpty");
    expect(vault.indexOf("<Segmented")).toBeLessThan(vault.indexOf("<Items"));
  });

  test("a page that didn't load offers to try again", () => {
    for (const file of [
      "features/vault/VaultScreen.tsx",
      "features/vault/VaultItemScreen.tsx",
      "features/vault/VaultAccessScreen.tsx",
      "features/vault/VaultConnectScreen.tsx",
      "features/vault/VaultConnectionScreen.tsx",
    ]) {
      const s = src(file);
      expect({ file, retry: s.includes("<LoadFailed onRetry=") }).toEqual({ file, retry: true });
      expect({ file, bare: s.includes('<Note icon="x">{t("common.loadFailed")}') }).toEqual({ file, bare: false });
    }
  });

  test("leaving a form with changes not saved asks first, and a finished save or delete doesn't", () => {
    for (const file of [
      "features/vault/VaultItemScreen.tsx",
      "features/vault/VaultAccessScreen.tsx",
      "features/vault/VaultEnvScreen.tsx",
      "features/vault/VaultNewScreen.tsx",
    ]) {
      const s = src(file);
      expect({ file, guard: s.includes("useUnsavedGuard(") }).toEqual({ file, guard: true });
      expect({ file, leave: s.includes("leave();") }).toEqual({ file, leave: true });
    }
  });
});

describe("the Vault's flows are real navigation", () => {
  test("Import .env is two pushed screens: the review is its own route, the keys handed over in a draft", () => {
    const env = src("features/vault/VaultEnvScreen.tsx");
    // No step swapped in place: the paste step pushes the review, the system's back comes back to the paste.
    expect(env).not.toContain("if (!file)");
    expect(env).toContain("openEnvDraft({ file: parsed, scope: asked, leave });");
    expect(env).toContain("router.push(vaultHref.envReview as never);");
    // No drawn way back ("Import another"): the system's back is it.
    expect(env).not.toContain('t("vault.import.another")');
    // Saved, the whole flow closes back to the Vault without asking about the paste.
    expect(env).toContain("draft.leave();");
    expect(env).toContain("router.dismissTo(vaultHref.list as never);");
    // The review takes the draft as it opens and drops it as it closes; without one it starts over.
    expect(env).toContain("const [draft] = useState(envDraftNow);");
    expect(env).toContain("useEffect(() => () => closeEnvDraft(draft), [draft]);");
    const route = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/settings/vault-env-review.tsx"), "utf8");
    expect(route).toContain("<VaultEnvReviewScreen />");
  });

  test("connecting a password manager ends on the connection's page, never a done step drawn in place", () => {
    const connect = src("features/vault/VaultConnectScreen.tsx");
    expect(connect).not.toContain("setMade");
    expect(connect).not.toContain("ConnectedNote");
    expect(connect).toContain("router.replace(vaultHref.connection(connected.id) as never);");
    expect(connect).toContain('title: t("mobile.vault.connect.connected", { name: source.name }),');
    // Its page waits for the Vault read again before it says a connection is gone.
    expect(src("features/vault/VaultConnectionScreen.tsx")).toContain("vault.isSuccess && !vault.isFetching ? (");
  });

  test("a connection's fields walk with the return key, under the keyboard's bar", () => {
    const connect = src("features/vault/VaultConnectScreen.tsx");
    expect(connect).toContain('{...(f.id === lastTyped ? { returnKeyType: "done" as const } : NEXT_FIELD)}');
    expect(connect).toMatch(/locked=\{busy\}\s+toolbar\s+>/);
  });

  test("the Vault's pages load in their rows' shape, never a spinner", () => {
    for (const file of [
      "features/vault/VaultScreen.tsx",
      "features/vault/VaultItemScreen.tsx",
      "features/vault/VaultAccessScreen.tsx",
      "features/vault/VaultConnectScreen.tsx",
      "features/vault/VaultConnectionScreen.tsx",
    ]) {
      const s = src(file);
      expect({ file, spinner: s.includes("ActivityIndicator") }).toEqual({ file, spinner: false });
      expect({ file, skeleton: s.includes("<SkeletonList rows={4} />") }).toEqual({ file, skeleton: true });
    }
  });
});

describe("Compartilhar com…", () => {
  test("the line to send is the app's text field, the sheet keeps a sheet's margins", () => {
    const share = src("features/share/ShareScreen.tsx");
    expect(share).toContain("<TextArea");
    expect(share).not.toContain("<TextInput");
    expect(share).toContain("content: { paddingHorizontal: SHEET_X, paddingTop: 8 },");
    expect(share).toContain("bar: { paddingHorizontal: SHEET_X, paddingVertical: 12 },");
  });

  test("the send button is the sheet's own footer: it rides over the keyboard while the line is typed", () => {
    const share = src("features/share/ShareScreen.tsx");
    expect(share).toContain('footerOptions: { position: "absolute" },');
    expect(share).toContain("footerStyle: { backgroundColor: colors.grouped },");
    // In the sheet's colors, pressing the latest send; the list leaves the keyboard's and the footer's inset to the sheet.
    expect(share).toMatch(/footer: hasShare \? \(\s*<SheetContent>/);
    expect(share).toContain("onPress={() => void sendNow.current()}");
    expect(share).not.toContain("automaticallyAdjustKeyboardInsets");
    expect(share).not.toContain("insets.bottom");
  });
});

describe("a file's screen and its share sheet", () => {
  test("a type the app doesn't draw says it has no preview, never the name the bar already shows", () => {
    const viewer = src("features/files/DocumentViewer.tsx");
    expect(viewer).toContain('title={t("mobile.files.noPreviewTitle")}');
    expect(viewer).not.toContain("title={info.name}");
  });

  test("a page, a PDF or a text loads in a page's shape, never a spinner", () => {
    const viewer = src("features/files/DocumentViewer.tsx");
    expect(viewer).not.toContain("ActivityIndicator");
    expect(viewer.match(/renderLoading=\{\(\) => <PageBones cover \/>\}/g)?.length).toBe(1);
    // A PDF's pages come in its own shape too, while its copy loads (ADR 0208).
    expect(src("features/files/PdfPages.tsx")).toContain("if (!copy.data) return <PageBones />;");
    expect(src("features/files/PageBones.tsx")).toContain("const pulse = usePulse();");
  });

  test("the share sheet loads in its rows' shape; a file that's gone says so as an empty state", () => {
    const sheet = src("features/files/ShareSheet.tsx");
    expect(sheet).not.toContain("ActivityIndicator");
    expect(sheet).toContain("<SkeletonList rows={4} />");
    expect(sheet).toContain('<EmptyState size="inline" icon="file" title={t("errors.artifact.notFound")} />');
  });
});

describe("a block opened whole", () => {
  test("loads in a page's shape under its bar, never a lone spinner", () => {
    const block = src("features/blocks/LiveBlock.tsx");
    const screen = block.slice(block.indexOf("export function BlockScreen("));
    expect(screen).not.toContain("ActivityIndicator");
    expect(screen).toContain("<PageBones />");
  });

  test("its fields stay above the keyboard and a drag takes the keyboard down", () => {
    const block = src("features/blocks/LiveBlock.tsx");
    const screen = block.slice(block.indexOf("export function BlockScreen("));
    expect(screen).toContain('keyboardShouldPersistTaps="handled"');
    expect(screen).toContain('keyboardDismissMode="interactive"');
    expect(screen).toContain("automaticallyAdjustKeyboardInsets");
  });

  test("Keep in Drive that failed says why, not a generic line", () => {
    const block = src("features/blocks/LiveBlock.tsx");
    const screen = block.slice(block.indexOf("export function BlockScreen("));
    expect(screen).toContain("onError: failed,");
    expect(screen).not.toContain('t("mobile.blocks.sendFailed")');
  });
});

describe("the search tab", () => {
  test("opens with the keyboard down: the field takes the focus only when the person taps it", () => {
    const search = src("features/search/SearchScreen.tsx");
    expect(search).not.toContain("FOCUS_DELAY_MS");
    // The only focus left is the one a filter word asks for (a tap on the screen already open).
    expect(search.match(/field\.current\?\.focus\(\)/g)?.length).toBe(1);
    expect(search.slice(search.indexOf("const startOp"))).toContain("field.current?.focus();");
  });

  test("a pull asks for the conversations and every search again", () => {
    const search = src("features/search/SearchScreen.tsx");
    expect(search).toContain('qc.refetchQueries({ queryKey: searchQueryRoot(orgId), type: "active" })');
    expect(search).toContain("pull={pull}");
  });

  test("a search that failed says so with a retry, never as nothing found", () => {
    const results = src("features/search/SearchResults.tsx");
    expect(results).toContain("const failed = words && hits.isError && !hits.data;");
    expect(results).toContain("{failed ? <LoadFailed onRetry={() => void hits.refetch()} /> : null}");
    expect(results).toContain("{words && !failed && isEmpty(r) && settingItems.length === 0 && !hits.isFetching ? (");
  });

  test("taking the filters off is the kit's button, not a press drawn by hand", () => {
    const filters = src("features/search/SearchFilters.tsx");
    expect(filters).not.toContain("<Pressable");
    expect(filters).not.toContain("styles.pressed");
    expect(filters).toMatch(
      /<Button\s+variant="ghost"\s+size="sm"\s+icon="x"\s+label=\{t\("searchPage\.filtersApplied"/,
    );
  });
});
