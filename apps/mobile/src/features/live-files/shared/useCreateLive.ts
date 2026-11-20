import { type LiveKind, useCreateLiveFile } from "@agenteschat/client";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { router } from "@/ui/navigation";
import { useErrorToast, useOrgId } from "../../shared/hooks";
import { liveRoute } from "../routes";

/**
 * "Novo" › Planilha, Apresentação, Quadro on the phone (ADR 0196 §9): an empty file named "Planilha sem título" in the
 * Drive (or in a conversation, with `where`), opened on its own screen once the server made it. One at a time: a
 * second tap while one is being made does nothing. A failure says why in a toast.
 */
export function useCreateLive() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { mutateAsync } = useCreateLiveFile(orgId);
  const failed = useErrorToast();
  const [busy, setBusy] = useState<LiveKind | null>(null);
  const making = useRef(false);
  const make = useCallback(
    async (kind: LiveKind, where: { channelId?: string | null; threadId?: string | null } = {}) => {
      if (making.current) return;
      making.current = true;
      setBusy(kind);
      try {
        const file = await mutateAsync({ kind, title: t(`live.kinds.untitled.${kind}`), ...where });
        router.push(liveRoute(kind, file.id));
      } catch (error) {
        failed(error);
      } finally {
        making.current = false;
        setBusy(null);
      }
    },
    [mutateAsync, t, failed],
  );
  return { make, busy };
}
