import { useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import * as DocumentPicker from "expo-document-picker";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/ui";
import { uploadPart } from "../files/upload-part";
import { useOrgId } from "../shared/hooks";

/**
 * "Upload file" on the Drive: the system's file picker, then the file into the Drive (the folder shown), with no
 * conversation.
 * `uploading`: the name of the file on its way, which the Drive shows in a card's place until it's there (a large file
 * takes a while, and a greyed "+" alone says nothing).
 */
export function useDriveUpload(onSaved: () => unknown, folderId: string | null = null) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const toast = useToast();
  const [uploading, setUploading] = useState<string | null>(null);
  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const a = res.canceled ? null : res.assets[0];
    if (!a) return;
    setUploading(a.name);
    try {
      const file = { uri: a.uri, name: a.name, type: a.mimeType ?? "application/octet-stream" };
      const saved = await api.artifacts.upload(orgId, uploadPart(file), folderId ? { folderId } : {});
      toast({ title: t("files.uploaded", { name: saved.title }), icon: "check" });
      await onSaved();
    } catch (e) {
      toast({ title: errorText(t, e), icon: "x" });
    } finally {
      setUploading(null);
    }
  };
  return { busy: uploading !== null, uploading, pick: () => void pick() };
}
