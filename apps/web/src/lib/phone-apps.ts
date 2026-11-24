import { instanceQuery } from "@agenteschat/client";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/context";

/** The Android app's page on Google Play, open to everyone: the app signs in to any server. */
const GOOGLE_PLAY = "https://play.google.com/store/apps/details?id=chat.agentes.app";

/** The iPhone app's public beta on TestFlight. */
const TESTFLIGHT = "https://testflight.apple.com/join/f5QtGMkg";

export interface PhoneStore {
  /** Also the label's key under `appsDownload`. */
  id: "testFlight" | "googlePlay";
  href: string;
  /** The maker's mark drawn beside the label (`ProviderLogo`). */
  mark: "apple" | "android";
}

/**
 * Where to get the phone apps from this server, iPhone first. Google Play is offered everywhere; the iPhone beta only
 * on agentes.chat's own servers (`Instance.cloud`), whose accounts are the ones it is open to.
 */
export function phoneStores(cloud: boolean): PhoneStore[] {
  return [
    ...(cloud ? [{ id: "testFlight", href: TESTFLIGHT, mark: "apple" } as const] : []),
    { id: "googlePlay", href: GOOGLE_PLAY, mark: "android" },
  ];
}

/** `phoneStores` for the server this page is open on. */
export function usePhoneStores(): PhoneStore[] {
  const instance = useQuery(instanceQuery(useApi()));
  return phoneStores(instance.data?.cloud === true);
}
