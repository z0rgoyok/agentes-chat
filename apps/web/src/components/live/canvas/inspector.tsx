import { useImageModels } from "@agenteschat/client";
import { formatInt, whenAt } from "@agenteschat/client/lib/format";
import type { ShapeView } from "@agenteschat/live/canvas";
import { Button, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * A picture's details (ADR 0197), opened from its bar's ⋯: the picture, how it was made (its prompt, model, who asked
 * and when, the pictures it started from), and Download, Copy image, Open (full size, with zoom). Variations and
 * asking about it are on the picture's bar, through the file's conversation (ADR 0199). Beside the plane, never over
 * it, so the picture stays in sight; on a narrow window it covers the plane's right side.
 */
export function ImageInspector({
  shape,
  readOnly,
  assetUrl,
  onDownload,
  onCopy,
  onOpen,
  onClose,
}: {
  shape: ShapeView;
  readOnly: boolean;
  assetUrl(assetId: string): string;
  onDownload(): void;
  onCopy(): void;
  onOpen(): void;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const models = useImageModels(org.id, { enabled: !readOnly });
  const gen = shape.gen;
  const by = gen?.by;
  const name = by
    ? by.kind === "agent"
      ? (dir.anyAgent(by.id)?.name ?? t("channel.unknownAgent"))
      : (dir.memberById.get(by.id)?.name ?? t("channel.unknownPerson"))
    : "";
  const model = gen ? (models.data?.find((m) => m.id === gen.model)?.label ?? gen.model) : null;
  return (
    <aside className="cnv-insp" aria-label={t("live.canvas.inspector.title")}>
      <header className="cnv-insp__head">
        <h2 className="cnv-insp__title">{gen ? t("live.canvas.inspector.generated") : t("live.canvas.kinds.image")}</h2>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("live.canvas.inspector.close")}
          title={t("live.canvas.inspector.close")}
          onClick={onClose}
        />
      </header>
      <div className="cnv-insp__body">
        {shape.asset && (
          <button
            type="button"
            className="cnv-insp__picture"
            aria-label={t("live.canvas.inspector.open")}
            onClick={onOpen}
            style={shape.nw && shape.nh ? { aspectRatio: `${shape.nw} / ${shape.nh}` } : undefined}
          >
            <img src={assetUrl(shape.asset)} alt={shape.alt ?? gen?.prompt ?? ""} draggable={false} />
          </button>
        )}
        {gen ? (
          <dl className="cnv-insp__facts">
            <dt>{t("live.canvas.inspector.prompt")}</dt>
            <dd className="cnv-insp__prompt">{gen.prompt}</dd>
            {model && (
              <>
                <dt>{t("live.canvas.inspector.model")}</dt>
                <dd>{model}</dd>
              </>
            )}
            {by && (
              <>
                <dt>{t("live.canvas.inspector.askedBy")}</dt>
                <dd className="cnv-insp__who">
                  {by.kind === "agent" ? (
                    <AgentAvatar agentId={by.id} name={name} size="xs" />
                  ) : (
                    <PersonAvatar id={by.id} name={name} size="xs" />
                  )}
                  <span>{t("live.canvas.inspector.byAt", { name, when: whenAt(t, i18n.language, gen.at) })}</span>
                </dd>
              </>
            )}
            {gen.from && gen.from.length > 0 && (
              <>
                <dt>{t("live.canvas.inspector.references")}</dt>
                <dd className="cnv-insp__refs">
                  {gen.from.map((asset) => (
                    <img key={asset} src={assetUrl(asset)} alt="" />
                  ))}
                </dd>
              </>
            )}
          </dl>
        ) : (
          shape.nw &&
          shape.nh && (
            <p className="cnv-insp__size small muted tabular">
              {t("live.canvas.inspector.size", {
                w: formatInt(i18n.language, shape.nw),
                h: formatInt(i18n.language, shape.nh),
              })}
            </p>
          )
        )}
        <div className="cnv-insp__acts">
          <Button size="sm" icon="download" onClick={onDownload}>
            {t("live.canvas.inspector.download")}
          </Button>
          <Button size="sm" icon="copy" onClick={onCopy}>
            {t("live.canvas.inspector.copy")}
          </Button>
          <Button size="sm" icon="expand" onClick={onOpen}>
            {t("live.canvas.inspector.open")}
          </Button>
        </div>
        {!gen && (
          <p className="cnv-insp__note small muted ac-iconline">
            <Icon name="image" size={16} />
            {t("live.canvas.inspector.uploaded")}
          </p>
        )}
      </div>
    </aside>
  );
}
