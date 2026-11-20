import { Redirect, useLocalSearchParams } from "expo-router";
import { signUpLinkTarget } from "@/features/auth/links";
import { useSession } from "@/providers/session";
import { LandOn } from "@/ui/navigation";

/** `https://app.agentes.chat/signup?email=&access=` opened in the app: an early-access email's link (ADR 0078). */
export default function SignUpLinkRoute() {
  const params = useLocalSearchParams<{ email?: string; access?: string }>();
  const target = signUpLinkTarget(useSession(), params);
  // Signed in already: the app under it (never a second copy of it).
  if (target === "/") return <LandOn href="/" />;
  return target ? <Redirect href={target} /> : null;
}
