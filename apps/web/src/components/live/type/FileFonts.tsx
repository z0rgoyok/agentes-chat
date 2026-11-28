import { type Artifact, useBringFont } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { type FontRef, fontAssetRef } from "@agenteschat/live";
import { Button, Dialog, DialogBody, DialogFooter, Field } from "@agenteschat/ui";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { DrivePicker } from "../slides/DrivePicker";
import { type FontChoices, FontPicker } from "./FontPicker";
import "./type.css";

/**
 * A file's own heading and text fonts (ADR 0220 §3, §8), from the font list's "Fontes da apresentação…" row: they
 * apply to every text that names no font of its own. Each pick is written at once, as every live change is.
 */
export function FileFontsDialog({
  open,
  onOpenChange,
  choices,
  value,
  onChange,
  onBring,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: FontChoices & { kind: "slides" | "document" };
  value: { heading: FontRef; body: FontRef };
  onChange: (role: "heading" | "body", ref: FontRef) => void;
  onBring: () => void;
}) {
  const { t } = useTranslation();
  // The file's own fonts list what they are, not the roles they fill here.
  const list: FontChoices = { kind: choices.kind, own: choices.own };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(`live.type.fileFonts.${choices.kind}`)}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody className="lf-filefonts">
        <p className="lf-filefonts__note">{t("live.type.fileFontsNote")}</p>
        <Field label={t("live.type.headings")}>
          <FontPicker
            look="field"
            choices={list}
            value={value.heading}
            label={t("live.type.headingFont")}
            onChange={(ref) => onChange("heading", ref)}
          />
        </Field>
        <Field label={t("live.type.body")}>
          <FontPicker
            look="field"
            choices={list}
            value={value.body}
            label={t("live.type.bodyFont")}
            onChange={(ref) => onChange("body", ref)}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" icon="drive" onClick={onBring}>
          {t("live.type.bringButton")}
        </Button>
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          {t("live.type.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Trazer fonte do Drive": the Drive's fonts in its picker; the one picked is copied into the file (the server reads
 * it and refuses what isn't a font), joins the file's font list, and goes where it was asked for (`then`).
 */
export function useFontFromDrive(
  orgId: string,
  fileId: string,
): {
  open: (then?: (ref: FontRef) => void) => void;
  picker: ReactNode;
} {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const bring = useBringFont(orgId, fileId);
  const [shown, setShown] = useState(false);
  const then = useRef<((ref: FontRef) => void) | null>(null);
  const pick = async (artifact: Artifact) => {
    setShown(false);
    try {
      const asset = await bring.mutateAsync(artifact.id);
      if (!asset.font) {
        toast.show(t("live.type.notFont"), "error");
        return;
      }
      toast.show(t("live.type.brought", { name: asset.font.family }), "success");
      then.current?.(fontAssetRef(asset.id));
    } catch (error) {
      toast.show(errorText(t, error, i18n.language, { maxMb: 25 }), "error");
    }
  };
  return {
    open: (next) => {
      then.current = next ?? null;
      setShown(true);
    },
    picker: (
      <DrivePicker
        orgId={orgId}
        accept="font"
        open={shown}
        onClose={() => setShown(false)}
        onPick={(artifact) => void pick(artifact)}
      />
    ),
  };
}
