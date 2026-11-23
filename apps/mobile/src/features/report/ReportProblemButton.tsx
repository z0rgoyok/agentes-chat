import { useHealth } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Sheet } from "@/ui";
import { useSheetIfAny } from "../shared/SheetHost";
import { type ReportProblemProps, ReportProblemSheet } from "./ReportProblemSheet";

/** Whether "Send a report" shows here: only on a self-hosted server. */
export const useProblemReports = () => useHealth().data?.edition === "selfhost";

/**
 * "Send a report", a quiet text button after the place's own way out. Its sheet opens in the screen's sheet host when
 * there is one (a conversation's rows are recycled), else on its own.
 */
export function ReportProblemButton(props: ReportProblemProps) {
  const { t } = useTranslation();
  const host = useSheetIfAny();
  const [open, setOpen] = useState(false);
  if (!useProblemReports()) return null;
  const show = () => (host ? host.open(<ReportProblemSheet {...props} onClose={() => host.close()} />) : setOpen(true));
  return (
    <>
      <Button variant="text" size="sm" label={t("problemReport.button")} onPress={show} />
      {!host && (
        <Sheet open={open} onClose={() => setOpen(false)}>
          {open && <ReportProblemSheet {...props} onClose={() => setOpen(false)} />}
        </Sheet>
      )}
    </>
  );
}
