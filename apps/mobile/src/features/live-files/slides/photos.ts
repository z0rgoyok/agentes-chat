import { type LiveAsset, useUploadAsset } from "@agenteschat/client";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/ui";
import { uploadPart } from "../../files/upload-part";
import { useErrorToast } from "../../shared/hooks";

/**
 * "Foto" in a presentation or on a canvas (ADR 0196 §8): the phone's photo library, then each picked photo up as a
 * picture of the file, its bytes read as the request is built (Expo's `fetch` refuses React Native's `{ uri }` parts,
 * `uploadPart`). The screen places what came back. `busy`: how many are on their way, for the screen to say so.
 */
export function usePhotoPick(orgId: string, fileId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = useErrorToast();
  const { mutateAsync } = useUploadAsset(orgId, fileId);
  const [busy, setBusy] = useState(0);
  const pick = useCallback(
    async (max = 1): Promise<LiveAsset[]> => {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        // Converted to JPEG as it is picked (a library's HEIC is no picture a browser draws).
        quality: 0.85,
        allowsMultipleSelection: max > 1,
        selectionLimit: Math.max(1, max),
        orderedSelection: true,
      });
      if (res.canceled || res.assets.length === 0) return [];
      setBusy(res.assets.length);
      const done: LiveAsset[] = [];
      let lastError: unknown = null;
      for (const a of res.assets) {
        try {
          const file = { uri: a.uri, name: a.fileName ?? "photo.jpg", type: a.mimeType ?? "image/jpeg" };
          done.push(await mutateAsync(uploadPart(file)));
        } catch (error) {
          lastError = error;
        } finally {
          setBusy((n) => Math.max(0, n - 1));
        }
      }
      if (lastError !== null) {
        if (done.length > 0) toast({ title: t("live.canvas.errors.someImagesLeft"), icon: "x" });
        else failed(lastError);
      }
      return done;
    },
    [mutateAsync, toast, failed, t],
  );
  return { pick, busy };
}
