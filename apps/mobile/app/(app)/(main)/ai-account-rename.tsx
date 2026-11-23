import { useLocalSearchParams } from "expo-router";
import { RenameAiAccountScreen } from "@/features/ai/AiAccountsScreen";

/** Renaming an AI account (`?machineId=&accountId=`), pushed from its row on Contas de IA. */
export default function AiAccountRenameRoute() {
  const { machineId, accountId } = useLocalSearchParams<{ machineId: string; accountId: string }>();
  return <RenameAiAccountScreen machineId={machineId ?? ""} accountId={accountId ?? ""} />;
}
