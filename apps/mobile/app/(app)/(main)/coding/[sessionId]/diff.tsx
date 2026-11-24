import { useLocalSearchParams } from "expo-router";
import { DiffScreen } from "@/features/coding/DiffScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

const SHA = /^[0-9a-f]{7,40}$/i;

/** A diff in a session (ADR 0215): `?scope=base`, `?scope=uncommitted&path=<path>` or `?scope=commit&sha=<sha>`. */
export default function SessionDiffRoute() {
  const { sessionId, scope, path, sha } = useLocalSearchParams<{
    sessionId: string;
    scope?: string;
    path?: string;
    sha?: string;
  }>();
  const kind = scope === "uncommitted" || scope === "commit" ? scope : "base";
  if (!isSafeId(sessionId) || (kind === "commit" && !(typeof sha === "string" && SHA.test(sha))))
    return <LandOn href="/coding" />;
  return (
    <DiffScreen
      sessionId={sessionId}
      scope={kind}
      path={typeof path === "string" && path !== "" ? path : null}
      sha={kind === "commit" ? (sha ?? null) : null}
    />
  );
}
