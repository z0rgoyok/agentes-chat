import { type ArtifactDetail, isLiveFileKind, useApi, useArtifact } from "@agenteschat/client";
import { formatJson, highlightCode } from "@agenteschat/client/lib/code";
import { isJsonFile, mediaKindOfArtifact } from "@agenteschat/client/lib/files";
import { isolatedPage } from "@agenteschat/client/lib/isolated-page";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { Button, EmptyState, type HeaderAction, type HeaderMenuItem, SCREEN_X, systemText, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { ISOLATED_WEB_VIEW, STORAGE_STANDINS } from "../blocks/logic";
import { CodeText, RawToggle } from "../chat/CodeCard";
import { MessageText } from "../chat/MessageText";
import { DeckPage, EditAs, SheetPage, useOfficeHtml } from "../live-files/office/OfficePages";
import { liveRoute } from "../live-files/routes";
import { useTalkFocus } from "../live-files/talk/hooks";
import { FileTalkLine } from "../live-files/talk/TalkLine";
import { chooseAction } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { copyText, PushedHeader, successHaptic } from "../shared/parts";
import { useFileActions } from "./actions";
import { extensionOf, fileInfo, fileRoute, isCodeName, textChunks } from "./logic";
import { useFileLine } from "./MessageFiles";
import { openFile } from "./open";
import { PageBones } from "./PageBones";
import { PdfPages } from "./PdfPages";
import { fileText } from "./source";

/**
 * A file opened from a message, the Drive or a link: a screen pushed with the platform's push. Its bar is the native
 * one: back, the file's name with its line under it ("Documento · 4 KB · Theo"), and two buttons: Enviar cópia (the
 * system's share sheet with the file) and the "…" with Compartilhar (who sees it and its link, ADR 0157), Copiar texto
 * and Ver no Drive (the system's own menu on iOS, the app's list of the same choices on Android). Under it the file
 * itself, the screen's whole width: Markdown and text drawn by the app, a page in a web view, a PDF page by page by
 * the system's own renderer (`PdfPages`), an Office file as the server read it (ADR 0198: a workbook in the
 * spreadsheet's grid, a deck's slides, a Word document's page) and an old table in the same grid, anything else says
 * it opens in another app. Pictures and videos open straight in the picture viewer (`openFile`), live files on their
 * own screens (ADR 0196); one reached here anyway (a file's link that didn't say what it was) goes on there, and a link
 * to a message of a picture's or a video's conversation opens the viewer, its conversation pushed over it at the
 * message (ADR 0208). A PDF has its conversation's line under it, which pushes the conversation over the pages.
 */
export function DocumentViewer({
  id,
  version,
  focusId = null,
}: {
  id: string;
  version?: number;
  /**
   * A message of the file's conversation to open at (`?m=`, ADR 0199): handed on to a live file's own screen, opened
   * over a PDF, or the conversation itself for a picture or a video (ADR 0208).
   */
  focusId?: string | null;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const line = useFileLine();
  const toast = useToast();
  const query = useArtifact(orgId, id, version);
  const detail = query.data;
  const actions = useFileActions(detail);
  const info = detail ? fileInfo(detail) : null;
  const textual = info?.view === "markdown" || info?.view === "text";
  // The page's own text, read once for the page and for Copiar texto.
  const text = useFileText(detail, textual);
  // A PDF, drawn by the system's own renderer on both platforms.
  const pdf = info?.view === "pdf";
  // Only a fallback: every way into a file opens a picture or a video in the picture viewer at once, and a live file on
  // its own screen. A link that didn't say what it was (a deep link, a name with no extension) lands here, and this
  // screen gives way to the right one.
  const media = info?.view === "image" || info?.view === "video" || info?.view === "live";
  useEffect(() => {
    if (!media || !detail) return;
    if (isLiveFileKind(detail.kind)) router.replace(liveRoute(detail.kind, detail.id, focusId));
    // A picture's or a video's: the viewer, its conversation pushed over it at the message (ADR 0208).
    else if (focusId && mediaKindOfArtifact(detail)) {
      const route = fileRoute({ id: detail.id, detail });
      router.replace({ ...route, params: { ...route.params, m: focusId } });
    } else openFile({ id: detail.id, detail }, undefined, { replace: true });
  }, [media, detail, focusId]);
  // A PDF's conversation (ADR 0208): its line under it, and a link to one of its messages opens it over the PDF.
  const pdfTalk = !media && mediaKindOfArtifact(detail) === "pdf" ? detail : undefined;
  useTalkFocus(pdfTalk, focusId);

  const copy = () => {
    if (text.data === undefined) return;
    void copyText(text.data).then((ok) => {
      if (ok) successHaptic();
      toast(ok ? { title: t("contextMenu.textCopied"), icon: "copy" } : { title: t("mobile.app.failed"), icon: "x" });
    });
  };
  // A block or a vote lives in its conversation, not in the Drive (ADR 0113): nothing to share or find there.
  const inDrive = detail?.inDrive !== false;
  const choices: HeaderMenuItem[] = [
    ...(inDrive
      ? [
          {
            icon: "person" as const,
            sf: "person.badge.plus" as const,
            label: t("share.button"),
            onPress: actions.shareSheet,
          },
        ]
      : []),
    ...(textual && text.data !== undefined
      ? [{ icon: "copy" as const, sf: "doc.on.doc" as const, label: t("contextMenu.copyText"), onPress: copy }]
      : []),
    ...(inDrive
      ? [{ icon: "drive" as const, sf: "folder" as const, label: t("mobile.files.drive"), onPress: actions.drive }]
      : []),
  ];
  const bar: HeaderAction[] = detail
    ? [
        {
          icon: "share",
          sf: "square.and.arrow.up",
          label: t("mobile.files.sendCopy"),
          disabled: actions.busy !== null,
          onPress: () => void actions.share(),
        },
        ...(choices.length > 0
          ? [
              {
                icon: "more" as const,
                sf: "ellipsis" as const,
                label: t("mobile.files.more"),
                menu: choices,
                // Android: the same choices in the app's list (iOS opens the menu from the button itself).
                onPress: () => chooseAction(info?.name ?? "", choices, t("mobile.common.cancel")),
              },
            ]
          : []),
      ]
    : [];

  return (
    <>
      {/* The file's name as the bar's title; what it is and who sent it, the line under it. */}
      <PushedHeader
        title={info?.name ?? ""}
        subtitle={info && detail ? line(info, [dir.nameOf(detail.createdBy)]) : undefined}
        actions={bar}
      />
      {query.isError && !detail ? (
        <Middle>
          <LoadFailed onRetry={() => void query.refetch()} />
        </Middle>
      ) : !detail || !info || media ? (
        // The text's shape while the file's details come (a picture or a video only until the viewer takes its place).
        <PageBones />
      ) : info.view === "html" ? (
        <HtmlPage detail={detail} />
      ) : info.view === "sheet" ? (
        <SheetPage detail={detail} />
      ) : info.view === "deck" ? (
        <DeckPage detail={detail} />
      ) : info.view === "word" ? (
        <WordPage detail={detail} />
      ) : textual ? (
        <TextPage detail={detail} markdown={info.view === "markdown"} json={isJsonFile(info.name, info.mime)} />
      ) : pdf ? (
        <PdfPages detail={detail} />
      ) : (
        // A type the app doesn't draw: that it has no preview (its name is the bar's title already), and the way to
        // open it in another app.
        <EmptyState
          size="page"
          icon="file"
          title={t("mobile.files.noPreviewTitle")}
          subtitle={t("mobile.files.noPreview")}
          action={
            <Button
              variant="secondary"
              icon="share"
              label={t("mobile.files.sendCopy")}
              loading={actions.busy === "share"}
              onPress={() => void actions.share()}
            />
          }
        />
      )}
      {pdfTalk ? <FileTalkLine file={pdfTalk} /> : null}
    </>
  );
}

/** What fills the screen under the bar, centred (a failure and its retry). */
function Middle({ children }: { children: ReactNode }) {
  return <View style={styles.middle}>{children}</View>;
}

/** A Markdown or text file's text, loaded once per version. */
function useFileText(detail: ArtifactDetail | undefined, enabled: boolean) {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: ["org", orgId, "artifacts", "text", detail?.id, detail?.shownVersion] as const,
    queryFn: () => fileText(api, orgId, detail as ArtifactDetail),
    enabled: enabled && detail !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Markdown with the messages' renderer, code colored by its extension and any other text in the app's, across the
 * screen as a page reads. JSON formatted and colored as a code block reads it, the text as written one press away
 * ("Original").
 */
function TextPage({ detail, markdown, json }: { detail: ArtifactDetail; markdown: boolean; json: boolean }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const text = useFileText(detail, true);
  // A note or a log reads as words; only code keeps the code font.
  const code = isCodeName(fileInfo(detail).name);
  const formatted = useMemo(() => (json && text.data !== undefined ? formatJson(text.data) : null), [json, text.data]);
  const [raw, setRaw] = useState(false);
  if (text.isError)
    return (
      <Middle>
        <LoadFailed onRetry={() => void text.refetch()} />
      </Middle>
    );
  if (text.data === undefined) return <PageBones />;
  return (
    <ScrollView style={styles.fill} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}>
      {markdown ? (
        <MessageText body={text.data} />
      ) : formatted !== null ? (
        <View style={styles.json}>
          {formatted !== text.data.trim() ? <RawToggle on={raw} onPress={() => setRaw((r) => !r)} /> : null}
          <CodeText lines={highlightCode(raw ? text.data : formatted, "json")} wrap />
        </View>
      ) : (
        // In pieces: a long file in one text view was taller than the phone draws, and showed blank.
        // Code is colored piece by piece: a block comment across two pieces loses its color in the second.
        textChunks(text.data).map((piece, i) =>
          code ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed text, in order
            <CodeText key={i} lines={highlightCode(piece, extensionOf(fileInfo(detail).name))} wrap />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed text, in order
            <RNText key={i} selectable style={[styles.prose, { color: c.ink2 }]}>
              {piece}
            </RNText>
          ),
        )
      )}
    </ScrollView>
  );
}

/** Before a page's own head: the phone's width, and stand-ins for the storage a page here has none of. */
const PAGE_HEAD = `<meta name="viewport" content="width=device-width, initial-scale=1">${STORAGE_STANDINS}`;

/**
 * A page (an HTML file, a page an agent made) drawn as a page, apart from the app as everything an agent writes runs
 * (ADR 0019: `ISOLATED_WEB_VIEW` with `isolatedPage`'s policy: no network, cookies, storage or way off it), at the
 * phone's width, scrolling by itself. On white, as a page is when it sets no background of its own.
 */
function HtmlPage({ detail }: { detail: ArtifactDetail }) {
  const inline = detail.content.kind === "html" ? detail.content.html : undefined;
  const text = useFileText(detail, inline === undefined);
  return <IsolatedHtml html={inline ?? text.data} failed={text.isError} onRetry={() => void text.refetch()} />;
}

/**
 * A Word document as the server read it (ADR 0198): clean HTML, drawn in the same isolated page as an agent's, with
 * what it is and "Editar como documento" under it.
 */
function WordPage({ detail }: { detail: ArtifactDetail }) {
  const doc = useOfficeHtml(detail, true);
  return (
    <View style={styles.fill}>
      <IsolatedHtml html={doc.html} failed={doc.failed} onRetry={doc.retry} />
      <EditAs detail={detail} view="word" />
      <BottomRoom />
    </View>
  );
}

/** The home indicator's room under a bar at the screen's foot. */
function BottomRoom() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return <View style={{ height: insets.bottom, backgroundColor: c.bg }} />;
}

/** HTML in the isolated web view (see `HtmlPage`), its shape while it comes, why it didn't. */
function IsolatedHtml({ html, failed, onRetry }: { html: string | undefined; failed: boolean; onRetry: () => void }) {
  const page = useMemo(() => (html !== undefined ? isolatedPage(html, PAGE_HEAD) : null), [html]);
  // A page the system ended (long in the background) comes back.
  const [life, setLife] = useState(0);
  if (page === null)
    return failed ? (
      <Middle>
        <LoadFailed onRetry={onRetry} />
      </Middle>
    ) : (
      <PageBones />
    );
  return (
    <WebView
      key={life}
      source={{ html: page }}
      {...ISOLATED_WEB_VIEW}
      startInLoadingState
      renderLoading={() => <PageBones cover />}
      onContentProcessDidTerminate={() => setLife((n) => n + 1)}
      onRenderProcessGone={() => setLife((n) => n + 1)}
      style={[styles.fill, styles.white]}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SCREEN_X },
  page: { paddingHorizontal: SCREEN_X, paddingTop: 12 },
  white: { backgroundColor: "#fff" },
  // The app's body, as a message's words.
  prose: systemText("body"),
  json: { gap: 10, alignItems: "flex-start" },
});
