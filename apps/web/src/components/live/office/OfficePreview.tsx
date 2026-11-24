import type { ArtifactFileContent, OfficePreview as OfficePreviewData } from "@agenteschat/client";
import { ApiError, isLiveFileKind, useOfficePreview, useOpenAs } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { type OfficePreviewKind, previewKind } from "@agenteschat/client/lib/files";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, cx, EmptyState, Icon, type IconName, Skeleton, SkeletonGroup } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HtmlFrame } from "@/components/artifacts/HtmlFrame";
import { useMaybeArtifactViewer } from "@/components/artifacts/viewer-context";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { openLivePage } from "../open";
import { DeckView } from "../slides";
import { WorkbookView } from "../spreadsheet";
import "../covers.css";

/** What kind of file it is, in words ("Arquivo do Excel"): by its name first, then its type. */
type OfficeWord = "excel" | "ods" | "csv" | "powerpoint" | "word";

const extensionOf = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";

export function officeWord(content: Pick<ArtifactFileContent, "name" | "contentType">): OfficeWord | null {
  const ext = extensionOf(content.name);
  if (ext === "xlsx" || ext === "xls") return "excel";
  if (ext === "ods") return "ods";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "pptx") return "powerpoint";
  if (ext === "docx") return "word";
  const kind = previewKind(content.contentType, content.name);
  if (kind === "office-sheet") return "excel";
  if (kind === "office-slides") return "powerpoint";
  return kind === "office-doc" ? "word" : null;
}

const ICON: Record<OfficePreviewKind, IconName> = {
  "office-sheet": "spreadsheet",
  "office-slides": "slides",
  "office-doc": "document",
};

/**
 * An uploaded Office file in the viewer (ADR 0198), drawn from the server's reading of it, never from its bytes here: a
 * workbook on the spreadsheet's own grid (read-only), a deck as its slides one under another, a Word document as clean
 * HTML in the isolated frame. A quiet line over it says what the file is, with "Editar como planilha / apresentação /
 * documento", which makes an editable copy beside it (the upload stays as it was).
 */
export function OfficePreview({
  artifactId,
  version,
  content,
  title,
  kind,
}: {
  artifactId: string;
  version: number;
  content: ArtifactFileContent;
  title: string;
  kind: OfficePreviewKind;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const query = useOfficePreview(org.id, artifactId, version);
  const preview = query.data;
  const bar = <OfficeBar artifactId={artifactId} content={content} kind={kind} preview={preview ?? null} />;

  if (query.isError) {
    // The server read the file and can't draw it (a format it doesn't take, a broken file): only the download is left.
    const unreadable = query.error instanceof ApiError && (query.error.status === 422 || query.error.status === 413);
    return (
      <div className="lf-office lf-office--state">
        <EmptyState
          size="panel"
          icon={ICON[kind]}
          title={unreadable ? t("live.office.failed") : t("live.office.loadFailed")}
          actions={
            unreadable ? undefined : <Button onClick={() => void query.refetch()}>{t("live.office.retry")}</Button>
          }
        >
          {unreadable ? undefined : errorText(t, query.error, i18n.language)}
        </EmptyState>
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="lf-office" data-kind={kind}>
        <div className="lf-office__bar">{bar}</div>
        <OfficeSkeleton kind={kind} label={t("live.office.loading")} />
      </div>
    );
  }
  if (preview.kind === "workbook") {
    return (
      <div className="lf-office" data-kind={kind}>
        <WorkbookView workbook={preview.workbook} locale={i18n.language} notice={bar} className="lf-office__sheet" />
      </div>
    );
  }
  return (
    <div className="lf-office" data-kind={kind}>
      <div className="lf-office__bar">{bar}</div>
      <div className={cx("lf-office__view", preview.kind === "document" && "lf-office__view--doc")}>
        {preview.kind === "deck" ? (
          <DeckView deck={preview.deck} />
        ) : (
          <HtmlFrame html={preview.html} title={t("live.office.frame", { title })} className="lf-office__doc" />
        )}
      </div>
    </div>
  );
}

/** "Arquivo do Excel · Editar como planilha": what the file is, and its editable copy for whoever may make files. */
function OfficeBar({
  artifactId,
  content,
  kind,
  preview,
}: {
  artifactId: string;
  content: ArtifactFileContent;
  kind: OfficePreviewKind;
  preview: OfficePreviewData | null;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const viewer = useMaybeArtifactViewer();
  const toast = useToast();
  const openAs = useOpenAs(org.id);
  const word = officeWord(content);
  const what: "workbook" | "deck" | "document" =
    preview?.kind ?? (kind === "office-sheet" ? "workbook" : kind === "office-slides" ? "deck" : "document");
  const edit = () =>
    openAs.mutate(artifactId, {
      onSuccess: (made) => {
        if (isLiveFileKind(made.kind)) {
          viewer?.close();
          openLivePage(navigate, org.id, made.id);
        } else if (viewer) viewer.open(made.id);
        toast.show(t("live.office.made", { title: made.title }));
      },
      onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
    });
  const words: ReactNode = (
    <span className="lf-office__kind">
      <Icon name={ICON[kind]} size={16} />
      <span>{word ? t(`live.office.kind.${word}`) : t("live.office.kind.file")}</span>
    </span>
  );
  return (
    <>
      {words}
      {can(org, "upload_files") && (
        <Button size="sm" loading={openAs.isPending} disabled={!preview} onClick={edit}>
          {t(`live.office.editAs.${what}`)}
        </Button>
      )}
    </>
  );
}

/** Loading: the shape of what comes (a grid, slides, a page), never a spinner alone. */
function OfficeSkeleton({ kind, label }: { kind: OfficePreviewKind; label: string }) {
  return (
    <SkeletonGroup label={label} className={cx("lf-skel", "lf-office__view", `lf-office__skel--${kind}`)}>
      {kind === "office-sheet" ? (
        <span className="lf-skel__grid" />
      ) : kind === "office-slides" ? (
        <span className="lf-office__slides">
          <Skeleton shape="block" className="lf-skel__slide" />
          <Skeleton shape="block" className="lf-skel__slide" />
        </span>
      ) : (
        <span className="lf-office__page">
          <Skeleton width="60%" height={20} />
          <Skeleton width="100%" />
          <Skeleton width="92%" />
          <Skeleton width="96%" />
          <Skeleton width="70%" />
        </span>
      )}
    </SkeletonGroup>
  );
}
