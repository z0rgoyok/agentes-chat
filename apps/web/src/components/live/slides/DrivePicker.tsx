import { type Artifact, useArtifacts } from "@agenteschat/client";
import { Dialog, DialogBody, EmptyState, SearchField, SkeletonGroup } from "@agenteschat/ui";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { DrivePreview } from "@/components/drive/DrivePreview";

/**
 * "Do Drive": a picture already in the workspace's Drive, put on the slide (ADR 0196 §8), or a font brought into the
 * file (ADR 0220 §2). The file is copied into the live file (the server checks the person reads it), so it keeps
 * showing to whoever reads it.
 */

/** Pictures the file's assets take: what the server accepts (the Drive can hold other images, like SVG, too). */
const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;

export function isPictureFile(artifact: Pick<Artifact, "kind" | "title">): boolean {
  return artifact.kind === "file" && IMAGE_NAME.test(artifact.title);
}

/** Fonts a file takes: what the server's font reader reads (TrueType, OpenType, WOFF). */
const FONT_NAME = /\.(ttf|otf|woff)$/i;

export function isFontFile(artifact: Pick<Artifact, "kind" | "title">): boolean {
  return artifact.kind === "file" && FONT_NAME.test(artifact.title);
}

export function DrivePicker({
  orgId,
  open,
  onClose,
  onPick,
  accept = "picture",
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
  onPick: (artifact: Artifact) => void;
  /** What it lists: pictures, or fonts. */
  accept?: "picture" | "font";
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const list = useArtifacts(orgId, { kind: "file", ...(query ? { q: query } : {}) });
  const fonts = accept === "font";
  const pictures = (list.artifacts ?? []).filter(fonts ? isFontFile : isPictureFile);
  const search = fonts ? t("live.type.bringSearch") : t("live.slides.image.driveSearch");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={fonts ? t("live.type.bringTitle") : t("live.slides.image.driveTitle")}
      closeLabel={t("common.close")}
      width={720}
    >
      <DialogBody className="sl-drivepick">
        <SearchField
          size="sm"
          value={q}
          aria-label={search}
          placeholder={search}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("live.slides.image.clearSearch")}
        />
        {list.isPending ? (
          <SkeletonGroup label={t("common.loadingList")} className="sl-drivepick__loading">
            <div className="sl-drivepick__grid" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className="sl-drivepick__ghost" />
              ))}
            </div>
          </SkeletonGroup>
        ) : list.isError ? (
          <EmptyState size="panel" icon="alert" title={t("common.loadFailed")} />
        ) : pictures.length === 0 ? (
          <EmptyState
            size="panel"
            icon={fonts ? "textTool" : "image"}
            title={fonts ? t("live.type.bringEmpty") : t("live.slides.image.driveEmpty")}
          />
        ) : (
          <ul className="sl-drivepick__grid">
            {pictures.map((a) => (
              <li key={a.id}>
                <button type="button" className="sl-drivepick__item" onClick={() => onPick(a)}>
                  <DrivePreview artifact={a} size="sm" />
                  <span className="sl-drivepick__name">{a.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <button
            type="button"
            className="ac-link ac-link--action sl-drivepick__more"
            onClick={() => void list.fetchNextPage()}
          >
            {t("live.slides.image.driveMore")}
          </button>
        )}
      </DialogBody>
    </Dialog>
  );
}
