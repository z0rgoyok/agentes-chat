import { ClosedStep } from "@/features/auth/SignInSteps";

/** The early-access link that opened the sign-up expired: said on its own screen over the e-mail. */
export default function SignInExpired() {
  return <ClosedStep expired />;
}
