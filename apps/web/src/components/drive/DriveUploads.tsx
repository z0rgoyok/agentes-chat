import { fileIcon } from "@agenteschat/client/lib/files";
import { Button, Icon, Spinner } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import type { UploadItem } from "@/components/artifacts/Upload";

/** The whole page while files are dragged over it. */
export function DropOverlay() {
  const { t } = useTranslation();
  return (
    <div className="drive-dropzone" aria-hidden="true">
      <div className="drive-dropzone__in">
        <span className="drive-dropzone__icon">
          <Icon name="upload" />
        </span>
        <b>{t("files.dropHint")}</b>
        <span>{t("drive.dropText")}</span>
      </div>
    </div>
  );
}

/** Glass card at the bottom: the batch being sent, file by file. */
export function UploadProgress({ queue, onHide }: { queue: UploadItem[]; onHide: () => void }) {
  const { t } = useTranslation();
  const status = {
    waiting: t("drive.uploadWaiting"),
    sending: t("drive.uploadSending"),
    done: t("drive.uploadDone"),
    failed: t("drive.uploadFailed"),
  };
  return (
    <div className="drive-uploads" role="status">
      <div className="drive-uploads__head">
        <Spinner />
        <b>{t("drive.uploading", { count: queue.length })}</b>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("drive.hideUploads")}
          title={t("drive.hideUploads")}
          onClick={onHide}
        />
      </div>
      <ul>
        {queue.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one batch, in order (names may repeat)
          <li key={i} className="drive-uploads__row" data-status={item.status}>
            <Icon name={item.status === "done" ? "check" : fileIcon(item.name)} size={16} />
            <span className="drive-uploads__name">{item.name}</span>
            <span className="drive-uploads__status">{status[item.status]}</span>
            <span className="drive-uploads__track" aria-hidden="true">
              <i />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
