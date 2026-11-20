/**
 * The workspace on screen, for what reads it outside React (`app/+native-intent.tsx`, a link in a message): a link to a
 * screen of this workspace opens it straight away, without the `/link` screen in between. Null while signed out, or
 * before a workspace is chosen.
 */
let onScreen: string | null = null;

export const workspaceOnScreen = (): string | null => onScreen;

/** Set by the signed-in app while it is mounted (`app/(app)/_layout.tsx`), back to null when it goes. */
export function noteWorkspaceOnScreen(orgId: string | null) {
  onScreen = orgId;
}
