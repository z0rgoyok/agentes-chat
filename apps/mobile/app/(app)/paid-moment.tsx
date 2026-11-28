import { PaidMomentSheet } from "@/features/billing/PaidMoment";
import { goBack } from "@/features/shared/parts";

/** The moment a workspace's plan turned on, opened by the app's own check (`usePlanTurnedOn`). */
export default function PaidMomentRoute() {
  return <PaidMomentSheet onClose={goBack} />;
}
