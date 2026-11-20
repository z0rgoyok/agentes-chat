import { useArtifact, useLivePeers } from "@agenteschat/client";
import type { Peer } from "@agenteschat/live/awareness";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import {
  Button,
  EmptyState,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  SCREEN_X,
  SkeletonList,
  Text,
  TOOL_H,
  textLineOf,
  useTheme,
} from "@/ui";
import { useFontScale } from "@/ui/text-scale";
import { Face, OpensAgent } from "../../shared/Face";
import { PushedLargeTitle } from "../../shared/PushedLargeTitle";
import { goBack } from "../../shared/parts";
import { hereGroups, liveClosed, peerWhere } from "../logic";
import { setFollowing, useFollowing } from "../shared/follow";
import { LiveUnavailable } from "../shared/LiveBar";
import { usePeerLook, useWhereText } from "../shared/peers";
import { useLiveDoc } from "../shared/useLiveDoc";

/** Faces in the list, as the members' list draws them. */
const FACE = 36;

/**
 * Who is in a live file now (ADR 0196 §5), pushed from the faces in its bar: the people and agents editing, then the
 * ones looking, this person first in their group ("Você"), each with where they are in their own color ("editando
 * B4:C10", "no slide 3", an agent's "escrevendo em B2:C40"). Seguir moves the file's view with theirs (back on the
 * file's screen, which says so and stops when the person moves it); Parar de seguir ends it. Hidden people never come
 * (the server leaves them out). The file stays open behind it, so whoever is here sees this person still in it.
 */
export function HereScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const live = useLiveDoc(id);
  const file = useArtifact(live.orgId, id);
  const peers = useLivePeers(live.room);
  const following = useFollowing(id);
  const closed = liveClosed(live);
  const groups = hereGroups(peers);
  const alone = peers.filter((p) => !p.self).length === 0;
  const kind = live.room?.kind ?? null;
  return (
    <PushedLargeTitle title={t("mobile.live.here.title")} grouped>
      <View style={styles.page}>
        {file.data?.title ? <GroupedFooter>{file.data.title}</GroupedFooter> : null}
        {closed ? (
          <LiveUnavailable reason={closed} />
        ) : !live.room || !live.loaded ? (
          <SkeletonList rows={3} />
        ) : (
          <>
            {groups.map((g) => (
              <Fragment key={g.key}>
                <GroupedHeader>{t(`mobile.live.here.group.${g.key}`)}</GroupedHeader>
                <GroupedList>
                  {g.peers.map((p) => (
                    <HereRow
                      key={`${p.user.kind}:${p.user.id}`}
                      leading
                      peer={p}
                      where={peerWhere(live.room?.doc ?? null, kind, p)}
                      followed={following === p.clientId}
                      onFollow={() => {
                        setFollowing(id, p.clientId);
                        // Back on the file, its view goes where they are.
                        goBack();
                      }}
                      onStop={() => setFollowing(id, null)}
                    />
                  ))}
                </GroupedList>
              </Fragment>
            ))}
            {alone ? (
              <EmptyState
                size="inline"
                icon="members"
                title={t("mobile.live.here.alone")}
                subtitle={t("mobile.live.here.aloneHint")}
              />
            ) : null}
          </>
        )}
      </View>
    </PushedLargeTitle>
  );
}

/** One person or agent: the face ringed in their color while they edit, the name, where they are, Seguir. */
function HereRow({
  peer,
  where,
  followed,
  onFollow,
  onStop,
}: {
  /** Marks the row as one with a face, so the list's hairline starts at its text. */
  leading: true;
  peer: Peer;
  where: ReturnType<typeof peerWhere>;
  followed: boolean;
  onFollow: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const look = usePeerLook()(peer.user);
  const whereText = useWhereText();
  const agent = peer.user.kind === "agent";
  const editing = peer.state.mode === "editing";
  const name = peer.self ? t("live.shell.presence.you") : look.name;
  const said = whereText(where);
  // What wraps under the name (where they are, two lines) never floats the face or "Seguir": both sit on the name's
  // line, centred on its middle.
  const nameLine = textLineOf("body", useFontScale());
  const onName = (size: number) => ({ marginTop: nameLine.middle - size / 2 });
  const face = (
    <View style={[styles.ring, agent ? styles.tile : styles.round, { borderColor: editing ? look.tint : c.raised }]}>
      <Face
        who={{ type: agent ? "agent" : "person", id: peer.user.id }}
        size={FACE}
        live={false}
        mode={agent && editing ? "run" : "idle"}
      />
    </View>
  );
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`${name}, ${said}`}
      accessibilityActions={
        peer.self
          ? []
          : [{ name: "activate", label: t(followed ? "live.shell.presence.unfollow" : "live.shell.presence.follow") }]
      }
      onAccessibilityAction={() => (followed ? onStop() : onFollow())}
    >
      <View style={onName(FACE)}>{agent ? <OpensAgent agentId={peer.user.id}>{face}</OpensAgent> : face}</View>
      <View style={styles.words}>
        <Text variant="body" numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        <Text variant="footnote" numberOfLines={2} style={{ color: editing ? look.tint : c.faint }}>
          {said}
        </Text>
      </View>
      {peer.self ? null : (
        <View style={onName(TOOL_H)}>
          <Button
            variant="text"
            size="sm"
            label={t(followed ? "live.shell.presence.unfollow" : "live.shell.presence.follow")}
            onPress={followed ? onStop : onFollow}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: SCREEN_X, paddingTop: 4 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight + 8,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  ring: { borderWidth: 2, margin: -2 },
  round: { borderRadius: (FACE + 4) / 2, overflow: "hidden" },
  tile: { borderRadius: Math.round((FACE + 4) * 0.3) },
  words: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontWeight: "600" },
});
