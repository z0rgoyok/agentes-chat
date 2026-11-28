import { type CodeSession, useCloseCodeSession } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { Linking } from "react-native";
import type { HeaderAction, HeaderMenuItem } from "@/ui";
import { router } from "@/ui/navigation";
import { useErrorToast, useOrgId } from "../shared/hooks";
import { showActionSheet } from "../shared/PickerSheet";
import { CODING_HREF, sessionPeopleHref, sessionTerminalHref } from "./logic";

/**
 * A session's "…" (ADR 0215), in its conversation's bar and on its code screen: what the web's header holds, as the
 * system's menu from the bar's button (the app's sheet on Android): its terminal, who is in it, its pull request, and closing it
 * (red). A commit or a merge is asked in the conversation, in the person's own words. Null until the session is known.
 */
export function useSessionMenu(session: CodeSession | null): HeaderAction | null {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const failed = useErrorToast();
  const close = useCloseCodeSession(orgId);
  if (!session) return null;
  const menu: HeaderMenuItem[] = [
    // The web's Terminal: a shell in the session's worktree, once it has one.
    ...(session.worktree.state === "ready"
      ? [
          {
            label: t("codeSessions.panel.terminal"),
            icon: "codeBlock" as const,
            sf: "terminal" as const,
            onPress: () => router.push(sessionTerminalHref(session.id) as never),
          },
        ]
      : []),
    {
      label: t("codeSessions.who.label"),
      icon: "members",
      sf: "person.2",
      onPress: () => router.push(sessionPeopleHref(session.id) as never),
    },
    ...(session.pr?.url
      ? [
          {
            label: t("codeSessions.view.openPr", { number: session.pr.number }),
            icon: "out" as const,
            sf: "arrow.up.right.square" as const,
            onPress: () => void Linking.openURL(session.pr?.url ?? ""),
          },
        ]
      : []),
    {
      label: t("codeSessions.view.close"),
      icon: "archive",
      sf: "archivebox",
      destructive: true,
      onPress: () =>
        close.mutate(session.id, {
          onSuccess: () => router.dismissTo(CODING_HREF as never),
          onError: failed,
        }),
    },
  ];
  // iOS opens the system's menu from the button; Android lists the same choices in the app's sheet.
  const onPress = () =>
    void showActionSheet(
      t("codeSessions.view.more"),
      menu.map((m) => ({ label: m.label, icon: m.icon, destructive: m.destructive, onPress: m.onPress })),
    );
  return { icon: "more", sf: "ellipsis", label: t("codeSessions.view.more"), onPress, menu };
}
