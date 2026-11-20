import { useLocalSearchParams } from "expo-router";
import { isPushedStep } from "@/features/onboarding/draft";
import { OnboardingPage } from "@/features/onboarding/OnboardingFlow";

/** A step of the first run (its name, what it does, its team, its plan), pushed over the one before it. */
export default function OnboardingStepRoute() {
  const { step } = useLocalSearchParams<{ step?: string }>();
  return <OnboardingPage step={isPushedStep(step) ? step : null} />;
}
