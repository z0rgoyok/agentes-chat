import { OnboardingPage } from "@/features/onboarding/OnboardingFlow";

/**
 * The first run's first page, pushed by the root layout over the app while there is no workspace to open (ADR 0162):
 * what the workspace is for, or, for one being set up, its name with the steps reached since pushed over it.
 */
export default function OnboardingRoute() {
  return <OnboardingPage />;
}
