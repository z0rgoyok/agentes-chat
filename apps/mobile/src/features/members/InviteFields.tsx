import { useChannels, useRoles } from "@agenteschat/client";
import type { InviteLists, RefusedPick } from "@agenteschat/client/lib/invite-start";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { everyoneOf, sortRoles } from "@agenteschat/client/lib/roles";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedField, Icon, Text, Token, TokenWrap } from "@/ui";
import { router } from "@/ui/navigation";
import { CargoMark } from "../roles/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { EMPTY_INVITE, type InviteDraft } from "./draft";
import { agentLines, cargoWords, startOf } from "./logic";

/** What a form's Cargo, Canais and Agentes give, as their fields show it and as it goes out. */
export interface StartFields {
  /** The fields, each its own child of the list they sit in. */
  fields: ReactElement[];
  /** The lines under the list: a person who won't talk to agents, an Administrador, restricted agents opening. */
  lines: string[];
  /** What goes out, past #general and the right hand (everyone joins and has them). */
  send: InviteLists;
}

/** The choices pushed over a form (`app/(app)/invite-pick.tsx`), writing to the form's draft. */
export type InvitePick = "cargo" | "channels" | "agents" | "ttl" | "max" | "note";
export const openPick = (draft: string, what: InvitePick) =>
  router.push({ pathname: "/invite-pick", params: { draft, what } });

/** A field's words cut to two lines of tokens, the ones left out counted at the end. */
const more = (count: number) => `+${count}`;

/**
 * Cargo, Canais and Agentes for a form (`key`, its draft), the web's dialog fields with each label over its field:
 * the picked cargos' marks and names (Todos' mark and "Membro" with none), #general and the right hand first and
 * fixed, then the cargos' channels and agents and the ones added; each field opens its choice. `readOnly` shows what a
 * link gives without opening anything; `refused` marks the pick the server turned down.
 */
export function useStartFields(
  key: string,
  draft: InviteDraft | null,
  opts: { refused?: RefusedPick | null; readOnly?: boolean } = {},
): StartFields {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const meId = useMeId();
  const dir = useDirectory();
  const roles = useRoles(orgId).data?.roles ?? [];
  const channels = useChannels(orgId).data ?? [];
  const personal = isPersonal(org);
  const everyone = everyoneOf(roles);
  const d: Pick<InviteDraft, "roleIds" | "added" | "removed"> = draft ?? EMPTY_INVITE;
  const start = startOf(roles, d);
  const general = channels.find((ch) => ch.name === "general");
  const right = dir.agents.find(isRightHand);
  // Who may open an agent to them: its owner, or who manages that agent (`inviteAgentCase` reads it from the agent).
  const viewer = { userId: meId ?? "" };
  const agentIds = start.agentIds.filter((id) => id !== right?.id);
  const talk = agentLines(t, { roles, roleIds: d.roleIds, agents: dir.agents, agentIds, viewer });
  const picked = sortRoles(roles.filter((r) => d.roleIds.includes(r.id)));
  const refused = opts.refused ?? null;
  const open = (what: InvitePick) => (opts.readOnly ? undefined : () => openPick(key, what));
  const roleLabel = personal ? t("invites.rolePersonal") : t("members.role");
  const channelLabel = personal ? t("shell.channelsPersonal") : t("invites.channels");
  const agentLabel = t("members.agents");
  const shownChannels = start.channelIds.flatMap((id) => {
    const ch = channels.find((x) => x.id === id);
    return ch && ch.id !== general?.id ? [ch] : [];
  });
  const shownAgents = talk.off
    ? []
    : agentIds.flatMap((id) => {
        const a = dir.agentById.get(id);
        return a ? [a] : [];
      });
  // A personal workspace with no group conversation besides #general has nothing to pick (ADR 0159).
  const noChannels = personal && !channels.some((ch) => ch.id !== general?.id);
  const fields: ReactElement[] = [
    <GroupedField
      key="cargo"
      stacked
      label={roleLabel}
      hint={{ name: t("common.about", { label: roleLabel }), text: t("invites.roleHint") }}
      {...(open("cargo") ? { onPress: open("cargo") } : {})}
    >
      <View style={styles.cargos}>
        {personal ? (
          <Text variant="callout">{cargoWords(t, roles, d.roleIds, true)}</Text>
        ) : picked.length === 0 ? (
          <View style={styles.cargo}>
            {everyone ? <CargoMark role={everyone} size={18} /> : null}
            <Text variant="callout">{t("roles.member")}</Text>
          </View>
        ) : (
          picked.map((r) => (
            <View key={r.id} style={styles.cargo}>
              <CargoMark role={r} size={18} />
              <Text variant="callout" style={styles.shrink}>
                {r.name}
              </Text>
            </View>
          ))
        )}
      </View>
    </GroupedField>,
    ...(noChannels
      ? []
      : [
          <GroupedField
            key="channels"
            stacked
            label={channelLabel}
            hint={{ name: t("common.about", { label: channelLabel }), text: t("invites.channelsHint") }}
            {...(open("channels") ? { onPress: open("channels") } : {})}
          >
            <TokenWrap lines={2} more={more}>
              {general ? (
                <Token key={general.id} label={general.name} leading={<Icon name="hash" size={14} color={c.muted} />} />
              ) : null}
              {shownChannels.map((ch) => (
                <Token
                  key={ch.id}
                  label={ch.name}
                  leading={<Icon name={ch.visibility === "private" ? "lock" : "hash"} size={14} color={c.muted} />}
                  tone={refused?.kind === "channel" && refused.id === ch.id ? "bad" : "neutral"}
                  fresh
                />
              ))}
            </TokenWrap>
          </GroupedField>,
        ]),
    <GroupedField
      key="agents"
      stacked
      label={agentLabel}
      hint={{ name: t("common.about", { label: agentLabel }), text: t("invites.agentsHint") }}
      {...(open("agents") && !talk.off ? { onPress: open("agents") } : {})}
    >
      <TokenWrap lines={2} more={more}>
        {right ? (
          <Token key={right.id} label={right.name} leading={<AgentFace agentId={right.id} size={20} live={false} />} />
        ) : null}
        {shownAgents.map((a) => (
          <Token
            key={a.id}
            label={a.name}
            leading={<AgentFace agentId={a.id} size={20} live={false} />}
            tone={refused?.kind === "agent" && refused.id === a.id ? "bad" : "neutral"}
            fresh
          />
        ))}
      </TokenWrap>
    </GroupedField>,
  ];
  return {
    fields,
    lines: talk.lines,
    send: {
      roleIds: d.roleIds,
      channelIds: start.channelIds.filter((id) => id !== general?.id),
      agentIds: talk.off ? [] : agentIds,
    },
  };
}

const styles = StyleSheet.create({
  cargos: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 4 },
  cargo: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
  shrink: { flexShrink: 1, minWidth: 0 },
});
