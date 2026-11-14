import { type Me, type OrgSummary, useApi, useMe } from "@agenteschat/client";
import { workspaceNotes } from "@agenteschat/client/lib/deletion";
import { CLOUD_SERVER, checkServer, normalizeServer, serverHost } from "@agenteschat/client/lib/server";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { addAccount, openWorkspace, problemText } from "@/features/server";
import { createApi } from "@/lib/api";
import { askNewWorkspace, offersNewWorkspaceHere } from "@/lib/new-workspace";
import { openOrgs } from "@/lib/org-choice";
import {
  ALLOW_HTTP,
  serverUrl,
  signedInServers,
  usePlace,
  usePlaceAccounts,
  useServer,
  useSignedInServers,
} from "@/lib/server";
import { serverOf } from "@/lib/server-choice";
import { useOrg, useOrgMaybe } from "@/providers/org";
import {
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  Locked,
  PersonAvatar,
  SheetScreen,
  useToast,
} from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { router } from "@/ui/navigation";
import { Text } from "@/ui/Text";
import { SheetHeader } from "../new/parts";
import { OrgAvatar } from "../shared/OrgAvatar";
import { goBack } from "../shared/parts";
import { useMyFace } from "../shared/tabHeader";
import { Page } from "./parts";
import { orderedServers, type ServerWorkspaces, unreadElsewhere, workspacesOf } from "./workspaces-logic";

/** How long a server's list stays fresh: each one is asked again after this when Workspaces opens. */
const FRESH_MS = 30_000;

/**
 * Every workspace of every server this phone is signed in to (ADR 0154), grouped by server, each with its unread
 * count: the current server from its own `me`, the others with their own sessions. A server that doesn't answer
 * keeps its group, saying so.
 */
export function useWorkspacesAcross(): { groups: ServerWorkspaces[]; elsewhere: number } {
  // Each place is a server, or one of its accounts (ADR 0183): a group each.
  const server = usePlace();
  const signedIn = useSignedInServers();
  const known = usePlaceAccounts();
  const org = useOrgMaybe();
  const api = useApi();
  const servers = orderedServers(signedIn, server);
  const results = useQueries({
    queries: servers.map((s) => ({
      queryKey: ["workspaces-across", s] as const,
      staleTime: FRESH_MS,
      queryFn: async (): Promise<{ me: Me | null; unread: { orgId: string; unread: number }[] }> => {
        const client = s === server ? api : createApi(s);
        const [me, unread] = await Promise.all([client.account.me(), client.account.unread().catch(() => null)]);
        return { me, unread: unread?.organizations ?? [] };
      },
    })),
  });
  const groups = servers.map((s, i) => {
    const r = results[i];
    const me = s === server && org ? { organizations: org.orgs } : (r?.data?.me ?? null);
    return workspacesOf({
      server: serverOf(s),
      place: s,
      email: r?.data?.me?.user.email ?? known[s]?.email ?? null,
      several: servers.filter((other) => serverOf(other) === serverOf(s)).length > 1,
      current: s === server,
      orgs: openOrgs(me?.organizations ?? []),
      unread: r?.data?.unread ?? [],
      // A failed refresh over a list already known keeps the list (faded); with nothing known, one line says so. The
      // open server's own list comes from the workspace in use, never faded.
      failed: Boolean(r?.isError) && !(s === server && org),
    });
  });
  return { groups, elsewhere: unreadElsewhere(groups, org?.orgId ?? null) };
}

/**
 * Opens a workspace from a list of them: the current server's by choosing it; another server's by moving there, the
 * toast saying where you are now ("Agora em …", on the axis it came from; nothing signs out, ADR 0154). The one close
 * (`dismissTo`) also takes down the sheet the list may sit in.
 */
export function useOpenWorkspaceRow() {
  const { t } = useTranslation();
  const toast = useToast();
  const org = useOrg();
  return (g: ServerWorkspaces, o: { id: string; name: string }) => {
    const here = g.current && o.id === org.orgId;
    if (here) return;
    haptics.light();
    // One close only: `dismissTo` below (or `openWorkspace`'s) also closes the sheet the list may sit in; closing it
    // separately raced the switch and left the stack half drawn.
    if (g.current) {
      org.setOrgId(o.id);
      router.dismissTo("/");
      return;
    }
    toast({ title: t("mobile.auth.server.now", { host: o.name }) });
    void openWorkspace(g.place, o.id);
  };
}

/**
 * A workspace's mark in a list: its logo (or the agent mark); a personal workspace of yours (ADR 0159) is you, so
 * your own photo, as the tabs' bar shows it. One shared with you keeps its logo: that face would be someone else's.
 */
export function WorkspaceMark({
  org,
  server,
  size = 30,
}: {
  org: Pick<OrgSummary, "mode" | "role" | "logo">;
  /** The place it is read from (a server, or one of its accounts), when it isn't the current one. */
  server?: string;
  size?: number;
}) {
  const face = useMyFace();
  if (isPersonal(org) && org.role === "owner")
    return <PersonAvatar name={face.name || "?"} size={size} photo={face.photo} />;
  return <OrgAvatar logo={org.logo} size={size} {...(server ? { server } : {})} />;
}

/**
 * The groups of workspaces, one per server ("Cloud", or "Seu servidor" and its host, as the small header), each workspace with its own mark (logo,
 * or its initial), its role, the check on the current one and the unread count on the others; a server that didn't
 * answer this time keeps its workspaces in their place, faded ("Sem resposta agora" when none is known). Shared by the
 * page and the sheet. A personal workspace of yours (ADR 0159) is you: your face and your name, and whose it is
 * instead of a role; with more than one, your face and each one's own name (the same name on each would tell them
 * apart by nothing).
 */
export function WorkspaceGroups({
  groups,
  onOpen,
}: {
  groups: ServerWorkspaces[];
  onOpen: ReturnType<typeof useOpenWorkspaceRow>;
}) {
  const { t, i18n } = useTranslation();
  const org = useOrg();
  const face = useMyFace();
  const mine = (o: Pick<OrgSummary, "mode" | "role">) => isPersonal(o) && o.role === "owner";
  return (
    <>
      {groups.map((g) => {
        const notes = workspaceNotes(t, i18n.language, g.orgs);
        const several = g.orgs.filter(mine).length > 1;
        return (
          <View key={g.place}>
            {/* Where they live: the Cloud by its name, one's own server by its host; and whose account, where the
                phone has several on that server (ADR 0183). */}
            <GroupedHeader>
              {[
                g.server === CLOUD_SERVER ? t("hosting.badge.cloud") : `${t("hosting.badge.own")} · ${g.host}`,
                g.several ? g.email : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </GroupedHeader>
            <GroupedList>
              {g.failed ? (
                <GroupedRow icon="wifi" label={t("mobile.me.workspacesUnreachable")} faint />
              ) : g.orgs.length === 0 && g.several && !g.current ? (
                // An account with no workspace yet: its own row is the way to it.
                <GroupedRow
                  icon="person"
                  label={g.email ?? g.host}
                  sub={t("mobile.me.accountNoWorkspace")}
                  onPress={() => void openWorkspace(g.place, null)}
                />
              ) : (
                g.orgs.map((o) => {
                  const here = g.current && o.id === org.orgId;
                  return (
                    <GroupedRow
                      key={o.id}
                      leading={<WorkspaceMark org={o} server={g.place} />}
                      label={mine(o) && !several && face.name ? face.name : o.name}
                      sub={notes.get(o.id) ?? t(modeKey(o, `mobile.me.role.${o.role}`))}
                      checked={here}
                      faint={g.quiet}
                      {...(!here && o.unread > 0 ? { value: String(o.unread) } : {})}
                      onPress={() => onOpen(g, o)}
                    />
                  );
                })
              )}
            </GroupedList>
          </View>
        );
      })}
    </>
  );
}

/** Workspaces: every server's, under a header each; tapping one opens it, on its server, without signing out. */
export function WorkspacesPage() {
  const { t } = useTranslation();
  const { groups } = useWorkspacesAcross();
  const open = useOpenWorkspaceRow();
  return (
    <Page title={t("mobile.me.workspaces")}>
      <WorkspaceGroups groups={groups} onOpen={open} />
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("mobile.me.addWorkspace")}
          chevron
          onPress={() => router.push("/me/add-workspace")}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.workspacesFoot")}</GroupedFooter>
    </Page>
  );
}

/**
 * Adicionar workspace, a short sheet (the system's form sheet, sized to its rows): on a server of one's own, a new one
 * there first; a new one on agentes.chat, or the team's own server; one line under them says nothing is lost.
 */
export function AddWorkspacePage() {
  const { t } = useTranslation();
  const server = useServer();
  const me = useMe().data;
  const create = () => {
    askNewWorkspace(CLOUD_SERVER);
    // Signed in to agentes.chat already: its first run opens over the app; otherwise its sign-in comes first.
    if (serverUrl() === CLOUD_SERVER) router.dismissTo("/");
    else void openWorkspace(CLOUD_SERVER, null);
  };
  return (
    <SheetScreen fit>
      {/* The sheets' bar: back to the list it came from, the title centered (as Novo's). */}
      <SheetHeader title={t("mobile.me.addWorkspace")} icon="back" />
      <GroupedList>
        {offersNewWorkspaceHere(server, me) ? (
          <GroupedRow
            icon="plus"
            label={t("shell.newWorkspace")}
            sub={serverHost(server)}
            chevron
            onPress={() => {
              // Signed in here already: the root layout opens the first run over the app for the ask.
              askNewWorkspace(server);
              router.dismissTo("/");
            }}
          />
        ) : null}
        <GroupedRow
          icon="plus"
          label={t("mobile.me.addWorkspaceCreate")}
          sub={t("mobile.me.addWorkspaceCreateSub")}
          chevron
          onPress={create}
        />
        <GroupedRow
          icon="person"
          label={t("mobile.me.addAccount")}
          sub={t("mobile.me.addAccountSub", { host: server === CLOUD_SERVER ? "agentes.chat" : serverHost(server) })}
          chevron
          onPress={() => void addAccount(server)}
        />
        <GroupedRow
          icon="server"
          label={t("mobile.me.addWorkspaceTeamShort")}
          sub={t("mobile.me.addWorkspaceTeamSubShort")}
          chevron
          onPress={() => {
            goBack();
            router.push("/me/team-server");
          }}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.addWorkspaceFoot")}</GroupedFooter>
    </SheetScreen>
  );
}

/**
 * Servidor da equipe, while signed in, on the sign-in's ruler (a low sky, the question in two lines): the address with
 * the URL keyboard open and its return key as the action, Escanear QR code below it as the one button, and one quiet
 * line: nothing signs out (ADR 0154). The server is checked first;
 * then the app moves there: signed in there already, its workspaces; otherwise its sign-in.
 */
export function TeamServerPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !address.trim()) return;
    const server = normalizeServer(address, { allowHttp: ALLOW_HTTP });
    if (!server) return setError(t("mobile.auth.server.invalid"));
    setBusy(true);
    setError(null);
    const check = await checkServer(server);
    if (!check.ok) {
      haptics.warning();
      setError(t(problemText(check.problem, check.server), { host: serverHost(check.server) }));
      return setBusy(false);
    }
    if (signedInServers().some((place) => serverOf(place) === check.server))
      toast({ title: t("mobile.auth.server.now", { host: serverHost(check.server) }) });
    await openWorkspace(check.server, null);
  };

  return (
    <AuthScaffold
      sky="low"
      title={t("mobile.me.teamServerQuestion")}
      subtitle={t("mobile.me.teamServerLeadShort")}
      onBack={goBack}
      agentMode={busy ? "run" : "idle"}
    >
      <Locked when={busy} keepKeyboard>
        <AuthField
          value={address}
          onChangeText={(value) => {
            setAddress(value);
            setError(null);
          }}
          placeholder={t("mobile.auth.server.placeholder")}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="URL"
          // The keyboard's blue key ("ir") is the action, as on the sign-in; gray until an address is typed.
          returnKeyType="go"
          enablesReturnKeyAutomatically
          onSubmitEditing={() => void submit()}
          accessibilityLabel={t("mobile.auth.server.label")}
          autoFocus
        />
      </Locked>
      {error ? (
        <Text tone="danger" variant="small" style={styles.center} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : busy ? (
        <Text variant="footnote" tone="muted" style={styles.center} accessibilityLiveRegion="polite">
          {t("mobile.auth.server.checking")}
        </Text>
      ) : null}
      <Button
        variant="secondary"
        wide
        label={t("mobile.auth.server.scan")}
        disabled={busy}
        onPress={() => router.push("/me/scan")}
      />
      <Text variant="footnote" tone="muted" style={[styles.center, styles.quiet]}>
        {t("mobile.me.addWorkspaceFoot")}
      </Text>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  gap: { height: 22 },
  center: { textAlign: "center" },
  quiet: { paddingTop: 8 },
});
