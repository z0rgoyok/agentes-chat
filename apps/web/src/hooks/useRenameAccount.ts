import { keys, useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * Names one of the viewer's AI accounts from wherever it is listed (the pencil after its title): every login of it
 * takes the name, and every list that shows it reads it again. A failure is said once and thrown, so the field stays.
 */
export function useRenameAccount() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return async (machineId: string, accountId: string, name: string) => {
    try {
      await api.machines.renameAccount(org.id, machineId, accountId, name);
    } catch (e) {
      toast.show(errorText(t, e, i18n.language), "error");
      throw e;
    }
    // Every agent's brain lists its accounts: the prefix of `keys.agentBrain` reads them all again.
    for (const key of [keys.aiAccounts(org.id), keys.planUsage(org.id), ["org", org.id, "agent"]])
      void qc.invalidateQueries({ queryKey: key });
  };
}
