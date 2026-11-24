export interface PhoneStore {
  id: "androidApk";
  href: string;
  mark: "android";
}

/** Only managed releases. iOS is distributed through personal TestFlight invitations. */
export function phoneStores(): PhoneStore[] {
  return [{ id: "androidApk", href: "/downloads/tich-rooms.apk", mark: "android" }];
}

export function usePhoneStores(): PhoneStore[] {
  return phoneStores();
}
