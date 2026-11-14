import { APP_ICONS, type AppIconId, DEFAULT_APP_ICON } from "@agenteschat/client/lib/app-icons";

/**
 * Each app icon's name on the phone's side (ADR 0179), as plugins/with-app-icons.js names it: iOS's asset catalog set
 * (the shipped one is the app's own, `null` to UIKit) and Android's launcher alias. Apart from app-icon.ts so a test
 * reads it without React Native.
 */
export function nativeIconName(id: AppIconId, os: string): string | null {
  if (os === "ios") return id === DEFAULT_APP_ICON ? null : `AppIcon-${id}`;
  return `AppIcon${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** The icon a native name stands for (an unknown name is the shipped one). */
export function iconOfNativeName(name: string | null, os: string): AppIconId {
  return APP_ICONS.find((id) => nativeIconName(id, os) === name) ?? DEFAULT_APP_ICON;
}
