import { NetworkError, useApi } from "@agenteschat/client";
import { type Href, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { openOwnPage } from "@/features/ai/parts";
import { linkWorkspace, resolveLink } from "@/features/links/app-links";
import { takeLink } from "@/features/links/pending";
import { useColors, useErrorToast } from "@/features/shared/hooks";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { landOn } from "@/ui/navigation";

/** How long a link waits for its workspace and its lookup before it gives up and says so: never a screen that waits forever. */
const LINK_WAIT_MS = 10_000;

/**
 * A link to the website opened in the app (`app/+native-intent.tsx`) that can't open its screen straight away: switches
 * to the link's workspace when the person is in it, then opens the screen it names (`resolveLink`), in place of this
 * one. Its bar's back leaves at any moment; a lookup that takes too long gives up as one that failed. A workspace they
 * aren't in opens the address on the website instead. One that can't open (a DM a workspace being deleted won't
 * start) lands on Conversas, saying why.
 */
export default function LinkRoute() {
  const p = useLocalSearchParams<{
    org?: string;
    to?: string;
    thread?: string;
    agent?: string;
    person?: string;
    notification?: string;
    m?: string;
    web?: string;
  }>();
  const { orgId, orgs, setOrgId } = useOrg();
  const api = useApi();
  const c = useColors();
  const failed = useErrorToast();
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const place = linkWorkspace(
    p,
    orgs.map((o) => o.id),
    orgId,
  );
  const wanted = "org" in place ? place.org : orgId;
  const foreign = "web" in place ? place.web : null;
  const { to, thread, agent, person, notification, m } = p;
  // It leaves once, whatever finishes first: the lookup, its failure or the wait running out.
  const settled = useRef(false);
  const land = useCallback((href: Href) => {
    if (settled.current) return;
    settled.current = true;
    landOn(href);
  }, []);
  useEffect(() => {
    takeLink();
    if (foreign !== null) {
      if (foreign !== "/") openOwnPage(`${serverUrl()}${foreign}`);
      land("/");
      return;
    }
    if (wanted !== orgId) {
      setOrgId(wanted);
      return;
    }
    let alive = true;
    resolveLink(api, orgId, { to, thread, agent, person, notification, m })
      .catch((e: unknown) => {
        if (alive && !settled.current) failedRef.current(e);
        return "/";
      })
      .then((href) => {
        if (alive) land(href as Href);
      });
    return () => {
      alive = false;
    };
  }, [api, orgId, wanted, foreign, setOrgId, to, thread, agent, person, notification, m, land]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (settled.current) return;
      failedRef.current(new NetworkError(new Error("link lookup timed out")));
      land("/");
    }, LINK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [land]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}
