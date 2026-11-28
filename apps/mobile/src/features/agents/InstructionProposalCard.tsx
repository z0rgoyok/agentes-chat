import {
  keys,
  type Message,
  type Proposal,
  useApplyProposal,
  useCardProposals,
  useUndoProposal,
} from "@agenteschat/client";
import { upperFirst } from "@agenteschat/client/lib/format";
import {
  appLabel,
  type ChangedLine,
  cardHead,
  firstChange,
  messageProposalCards,
  proposalSections,
  proposalTarget,
  proposalTitle,
  proposerOf,
} from "@agenteschat/client/lib/proposals";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Chip, DiffView, Icon, RowAction, Text, useTheme } from "@/ui";
import { boldRuns } from "../chat/actions";
import { type AskAnswer, AskCard } from "../chat/asks";
import { MessageText } from "../chat/MessageText";
import { IconTile } from "../connectors/ConnectorIcon";
import { useFailed } from "../routines/hooks";
import { Face } from "../shared/Face";
import { useDirectory, useMeId, useWhen } from "../shared/hooks";
import { proposalOutcome } from "./logic";

/** The proposal cards an agent's message carries (`meta.memoryUpdates`, or an older `meta.proposalId`). */
export function InstructionProposals({ message: m }: { message: Message }) {
  return (
    <>
      {messageProposalCards(m.meta).map((ids) => (
        <InstructionProposalCard key={ids.join(",")} ids={ids} />
      ))}
    </>
  );
}

/**
 * The web's card for what an agent proposed (its own or its teammates' instructions, roles and apps, or the org
 * context): each change once, and how it ended. Nobody is asked to decide it (ADR 0219): the agent's review applies
 * it or leaves it out a few seconds after, so it reads "Reviewing…" until then, then who applied it, the review's why
 * under it and Undo while the viewer may put it back. With several rows, each says how it ended on its own line.
 */
export function InstructionProposalCard({ ids }: { ids: string[] }) {
  const { orgId } = useOrg();
  const rows = useCardProposals(orgId, ids);
  return rows.length > 0 ? <ProposalRowsCard id={ids.join(",")} rows={rows} /> : null;
}

/** The card for rows already read (the history of agents' improvements reads them all at once, not one per card). */
export function ProposalRowsCard({ id, rows }: { id: string; rows: Proposal[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const when = useWhen();
  const { colors } = useTheme();
  const meId = useMeId();
  const [first] = rows;
  if (!first) return null;
  const agentName = (agentId: string) => dir.anyAgent(agentId)?.name || t("channel.unknownAgent");
  const orgName = org?.name ?? "";
  const head = cardHead(t, rows, agentName(proposerOf(first)), agentName, org ?? orgName);
  const runs = boldRuns(t(head.key, head.values) as string);
  const many = rows.length > 1;
  const reviewing = rows.some((p) => proposalOutcome(t, p, meId).reviewing);
  const rowList = (list: Proposal[]) => (
    <>
      {list.map((p) => {
        const name = p.target.type === "org_context" ? orgName : agentName(p.agentId);
        const outcome = proposalOutcome(t, p, meId);
        return (
          <View key={p.id} style={styles.row}>
            <View style={styles.line}>
              {p.target.type === "org_context" ? (
                <Icon name="members" size={24} color={colors.ink2} />
              ) : (
                <Face who={{ type: "agent", id: p.agentId }} size={24} live={false} />
              )}
            </View>
            <View style={styles.fill}>
              <View style={styles.line}>
                <Text variant="body" style={styles.bold} numberOfLines={1}>
                  {name}
                </Text>
              </View>
              <SettingChange p={p} />
              <Text variant="footnote" tone="muted">
                {outcome.words}
              </Text>
              {outcome.why ? (
                <Text variant="footnote" tone="faint">
                  {outcome.why}
                </Text>
              ) : null}
            </View>
            {p.undoable || p.applicable ? (
              <View style={styles.line}>
                {p.undoable ? <UndoProposal id={p.id} row /> : <ApplyProposal id={p.id} row />}
              </View>
            ) : null}
          </View>
        );
      })}
    </>
  );
  const groups = proposalSections(rows);
  const texts = groups.flatMap((g) => (g.kind === "text" && g.lines.length > 0 ? [g] : []));
  const firstLine = firstChange(texts[0]?.lines);
  const change =
    texts.length > 0 ? { label: t("ask.seeChange"), content: <Diffs lines={texts.map((g) => g.lines)} /> } : null;
  const only = many ? undefined : first;
  // One row: how it ended where a request's decision would be, the review's why under it, and Undo. Several: each row
  // says it on its own line, and the card's foot stays empty.
  const single = only ? proposalOutcome(t, only, meId) : null;
  const answer: AskAnswer | null =
    only && single && !single.reviewing
      ? {
          done: single.applied,
          words: single.words,
          time: single.at ? when.short(single.at) : undefined,
          note: single.why,
          actions: only.undoable ? (
            <UndoProposal id={only.id} />
          ) : only.applicable ? (
            <ApplyProposal id={only.id} />
          ) : null,
        }
      : null;
  return (
    <AskCard
      id={id}
      kind="proposal"
      agentId={proposerOf(first)}
      waitsFor={reviewing ? t("mobile.proposals.reviewing") : null}
      answer={answer}
      ended={many && !reviewing}
      lead={only ? proposalTitle(t, only, org ?? orgName, agentName) : runs.map((r) => r.text).join("")}
      well={
        only
          ? {
              tile: <IconTile name={only.target.type === "agent_access" ? "bolt" : "file"} size={20} bare />,
              // Written to follow "propõe ·", lowercase in most languages: a title starts with a capital.
              title: upperFirst(proposalTarget(t, only, agentName, org ?? orgName), i18n.language),
              detail:
                only.target.type === "agent_role"
                  ? t("proposals.roleLine", { from: only.before, to: only.after })
                  : firstLine?.text,
              more: change,
            }
          : firstLine
            ? { tile: <IconTile name="file" size={20} bare />, title: firstLine.text, more: change }
            : null
      }
      body={
        only ? (
          only.target.type === "agent_access" ? (
            <SettingChange p={only} />
          ) : undefined
        ) : (
          rowList(groups.flatMap((g) => g.rows))
        )
      }
    />
  );
}

/**
 * Undo on a change that was applied (ADR 0219), by whoever may make it: the row comes back undone, and the agents are
 * read again (what it put back). `row`: the word at a row's side, as a list's; else the card's ghost button.
 */
export function UndoProposal({ id, row = false }: { id: string; row?: boolean }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const failed = useFailed();
  const undo = useUndoProposal(orgId);
  const onPress = () =>
    undo.mutate(id, {
      onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(orgId) }),
      onError: failed,
    });
  return row ? (
    <RowAction strong label={t("teamWeek.undo")} disabled={undo.isPending} onPress={onPress} />
  ) : (
    <Button variant="ghost" size="card" label={t("rightHand.card.undo")} loading={undo.isPending} onPress={onPress} />
  );
}

/**
 * "Apply anyway" on a change the agent's review left out, by whoever may make it: applied as them, the row then reads
 * applied by them. `row`: the word at a row's side; else the card's ghost button.
 */
export function ApplyProposal({ id, row = false }: { id: string; row?: boolean }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const failed = useFailed();
  const apply = useApplyProposal(orgId);
  const onPress = () => apply.mutate(id, { onError: failed });
  return row ? (
    <RowAction strong label={t("proposals.applyAnyway")} disabled={apply.isPending} onPress={onPress} />
  ) : (
    <Button
      variant="ghost"
      size="card"
      label={t("proposals.applyAnyway")}
      loading={apply.isPending}
      onPress={onPress}
    />
  );
}

/** What "See the change" opens: each change once. */
function Diffs({ lines }: { lines: ChangedLine[][] }) {
  return (
    <>
      {lines.map((l) => (
        <ProseDiff key={l.map((x) => x.text).join("\n")} lines={l} />
      ))}
    </>
  );
}

/** A change to instructions or the context as the web draws it: Markdown blocks, added on green, removed on red. */
function ProseDiff({ lines }: { lines: ChangedLine[] }) {
  const { t } = useTranslation();
  return (
    <DiffView
      prose
      lines={lines}
      render={(text, kind) => <MessageText body={text} small muted={kind === "del"} selectable={false} />}
      folded={(count) => t("proposals.sameLines", { count })}
    />
  );
}

/** What a role or access row changes: "Função: Dev → Revisora", or a chip per app turned on or off. */
function SettingChange({ p }: { p: Proposal }) {
  const { t } = useTranslation();
  if (p.target.type === "agent_role")
    return (
      <Text variant="footnote" tone="muted">
        {t("proposals.roleLine", { from: p.before, to: p.after })}
      </Text>
    );
  if (p.target.type !== "agent_access") return null;
  return (
    <View style={styles.chips}>
      {(p.access ?? []).map((l) => (
        <Chip
          key={l.id}
          icon={l.on ? "plus" : "x"}
          label={t(l.on ? "proposals.accessOn" : "proposals.accessOff", { app: appLabel(t, l) })}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  /** A row's first line, as tall as its Undo: the face, the name and Undo sit centered on it. */
  line: { minHeight: 28, justifyContent: "center" },
  fill: { flex: 1, minWidth: 0, gap: 4 },
  bold: { fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
