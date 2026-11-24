import type { ConnectorDef } from "@agenteschat/client";
import { brandLook } from "@agenteschat/client/lib/brand-look";
import { personalAllowed } from "@agenteschat/client/lib/connected";
import { connectorDescription, connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  EmptyState,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  IconTile,
  SideScroll,
  SkeletonList,
  Text,
  useTheme,
} from "@/ui";
import { CoverParallax, useCoverScroll } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { BrandArt } from "./BrandArt";
import { openConnection } from "./ConnectionScreen";
import { ConnectorIcon } from "./ConnectorIcon";
import { openService, ShelfRow, useGallery } from "./ConnectorsScreen";
import { ConnectSheet } from "./ConnectSheet";
import { capabilityLines, categoryIcon, connectionOf, galleryTiles, relatedServices, serviceFacts } from "./logic";

/** The page's brand art, behind the bar and the mark, going into the page under it. */
const SKY = 300;
/** The service's mark over its art. */
const MARK = 100;
/** One column of the facts that slide sideways. */
const FACT = 108;

/**
 * A service of the catalog on a page of its own, pushed from its row in Conectores (or a category's, a search's, its
 * page's "Mais em …"): its mark in the middle of its brand's art (its mark in tilted rows, a brand color each, as the
 * web's service dialog), its name and what it is, then Conectar across the page, which goes straight to connecting (the sheet's connecting step;
 * the page already said what it does). Under it the facts that slide sideways (its category, how many tools and how
 * many ask for approval, who connects it, how one signs in), what agents do with it (what always asks marked), the
 * same facts as a grouped list, and the others of its category. Connected, the page says so, who uses it, and opens
 * the connection's own screen. Whoever can't connect it reads who does. Only what the catalog says: a vendor's server
 * shows its tools once connected, so the page says they come then.
 */
export function ServicePage({ id, personal }: { id: string; personal: boolean }) {
  return (
    <SheetHostProvider>
      <Service id={id} personal={personal} />
    </SheetHostProvider>
  );
}

function Service({ id, personal: fromPersonal }: { id: string; personal: boolean }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const g = useGallery(fromPersonal ? "personal" : "team");
  const def = g.catalog.data?.connectors.find((d) => d.id === id);
  if (!def)
    return (
      <View style={[styles.fill, { backgroundColor: colors.grouped }]}>
        <PushedHeader title="" grouped />
        {g.catalog.isLoading ? (
          <SkeletonList rows={4} />
        ) : g.catalog.isError ? (
          <LoadFailed onRetry={() => void g.catalog.refetch()} />
        ) : (
          <EmptyState size="inline" title={t("mobile.connectors.page.missing")} />
        )}
      </View>
    );
  return <Page def={def} g={g} />;
}

function Page({ def, g }: { def: ConnectorDef; g: ReturnType<typeof useGallery> }) {
  const { t, i18n } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const { org, tabs, personal, list, frozen, manages, sheet } = g;
  const name = connectorName(t, def);
  const line = connectorDescription(t, def);
  const existing = connectionOf(def, tabs.items);
  const opens = galleryTiles([def], tabs.items)[0]?.opens ?? false;
  // As the connect sheet decides: the team's for who manages connectors, one's own for anyone (GitHub: the team's).
  const mayConnect = !frozen && (manages || personalAllowed(def.id));
  const facts = serviceFacts(def);
  const category = t(`connectors.category.${def.category}`);
  // Who connects it: one's own (Pessoal, or anyone who doesn't manage connectors), whoever runs a personal workspace,
  // or the team's admins.
  const yours = personal || (!manages && personalAllowed(def.id));
  const who = yours
    ? t("mobile.connectors.page.whoYou")
    : isPersonal(org)
      ? t("mobile.connectors.page.whoRuns")
      : t("mobile.connectors.page.whoAdmins", { org: org?.name ?? "" });
  const how = t(`mobile.connectors.page.how.${facts.how}`);
  const tr = t as unknown as (key: string) => string;
  const caps = capabilityLines(
    tr,
    (k) => i18n.exists(k),
    def,
    (s) => scopeText(t, s).label,
  );
  // A vendor's server says nothing of its tools until it is connected: how they are handled then.
  const lines =
    caps.length > 0
      ? caps
      : [
          { text: t("connectors.otherSteps.2"), asks: false, said: true },
          { text: t("connectors.otherSteps.ask"), asks: true, said: true },
        ];
  const offered = galleryTiles(list, tabs.items)
    .filter((x) => x.opens && !x.connected)
    .map((x) => x.def);
  const related = relatedServices(def, offered);
  const users = (existing?.agentIds ?? []).filter((a) => dir.agentById.has(a));
  const connect = () => sheet.open(<ConnectSheet def={def} personal={personal} fromPage />);
  // The art moves with the page as every cover does: slower as it scrolls up, stretched into a pull down (never a
  // still band that leaves the page's gray above it).
  const { y, onScroll } = useCoverScroll();

  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      {/* The clear bar over the art: the system's back alone (nothing of ours in it). */}
      <PushedHeader title="" plate solid={false} grouped />
      <Animated.ScrollView
        style={styles.fill}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View>
          <CoverParallax y={y} style={styles.sky}>
            <BrandArt
              look={brandLook(def.iconUrl, def.brandColor)}
              template="pattern"
              surface={c.grouped}
              dark={scheme === "dark"}
              words="down"
            />
          </CoverParallax>
          <View style={[styles.hero, { paddingTop: insets.top + 58 }]}>
            <View style={[styles.mark, { boxShadow: MARK_SHADOW }]}>
              <ConnectorIcon def={def} label={name} size={MARK} />
            </View>
            <Text variant="display2" style={styles.center} numberOfLines={2}>
              {name}
            </Text>
            <Text variant="small" tone="muted" style={styles.center} numberOfLines={3}>
              {line}
            </Text>
            <View style={styles.act}>
              {existing ? (
                <>
                  <View style={styles.connected}>
                    <Icon name="check" size={15} color={c.ok} />
                    <Text variant="small" style={[styles.bold, { color: c.ok }]}>
                      {t("mobile.connectors.page.connected")}
                    </Text>
                  </View>
                  {users.length > 0 ? (
                    <View style={styles.users}>
                      <View style={styles.faces}>
                        {users.slice(0, 3).map((a, i) => (
                          <View key={a} style={i > 0 ? [styles.over, { borderColor: c.grouped }] : null}>
                            <AgentFace agentId={a} size={18} live={false} />
                          </View>
                        ))}
                      </View>
                      <Text variant="footnote" tone="muted" numberOfLines={1}>
                        {t("mobile.connectors.usedBy", {
                          count: users.length,
                          names: users.map((a) => dir.agentById.get(a)?.name ?? "").join(", "),
                        })}
                      </Text>
                    </View>
                  ) : existing.account ? (
                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                      {existing.account}
                    </Text>
                  ) : null}
                  <View style={styles.button}>
                    <Button
                      variant="secondary"
                      size="md"
                      wide
                      label={t("mobile.connectors.page.open")}
                      onPress={() => openConnection(existing.id)}
                    />
                  </View>
                </>
              ) : !opens ? (
                <Text variant="small" tone="muted" style={styles.center}>
                  {t("mobile.connectors.soon")}
                </Text>
              ) : mayConnect ? (
                <View style={styles.button}>
                  <Button variant="primary" size="md" wide label={t("mobile.connectors.connect")} onPress={connect} />
                </View>
              ) : frozen ? null : (
                <Text variant="small" tone="muted" style={styles.center}>
                  {/* A personal workspace's are whoever runs it, never "an admin of Personal" (ADR 0159). */}
                  {t(modeKey(org, "mobile.connectors.adminsOnly"), { org: org?.name ?? "" })}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* The facts, sliding sideways (a fade at the edge where more of them waits): what it is, what it brings,
            who connects it, how one signs in. */}
        <SideScroll fade={c.grouped} style={[styles.facts, { borderColor: c.separator }]}>
          <Fact
            label={t("mobile.connectors.page.category")}
            icon={categoryIcon(def.category) as IconName}
            sub={category}
          />
          <Fact
            label={t("mobile.connectors.page.tools")}
            divider
            {...(facts.tools === null
              ? { icon: "plug" as IconName, sub: t("mobile.connectors.page.toolsLater") }
              : {
                  value: String(facts.tools),
                  sub:
                    facts.asks > 0
                      ? t("mobile.connectors.page.toolsAsk", { count: facts.asks })
                      : t("mobile.connectors.page.toolsAskNone"),
                })}
          />
          <Fact label={t("mobile.connectors.page.who")} icon="shield" sub={who} divider />
          <Fact
            label={t("mobile.connectors.page.signIn")}
            icon={facts.how === "key" ? "key" : "person"}
            sub={how}
            divider
          />
        </SideScroll>

        {/* Every section under the grouped lists' own header, one hierarchy down the page. What agents do with it, as
            grouped rows with their tiles; what always asks for approval is the orange shield's row, its words saying
            so (no tag). */}
        <View style={styles.groups}>
          {lines.length > 0 ? (
            <>
              <GroupedHeader>{t("mobile.connectors.page.canTitle")}</GroupedHeader>
              <GroupedList>
                {lines.map((l) => (
                  <GroupedRow
                    key={l.text}
                    leading={l.asks ? <IconTile icon="shield" tint="orange" /> : <IconTile icon="sparkle" />}
                    label={l.asks && !l.said ? t("mobile.connectors.asks", { text: l.text }) : l.text}
                    labelLines={0}
                  />
                ))}
              </GroupedList>
            </>
          ) : null}
          {/* Where it connects, the one fact the strip above doesn't say (nothing said twice). */}
          {facts.host ? (
            <>
              <GroupedHeader>{t("mobile.connectors.page.address")}</GroupedHeader>
              <GroupedList>
                <GroupedRow icon="globe" label={t("mobile.connectors.page.host")} value={facts.host} />
              </GroupedList>
              <GroupedFooter>{t("mobile.connectors.page.addressNote")}</GroupedFooter>
            </>
          ) : null}
        </View>

        {related.length > 0 ? (
          <ShelfRow
            grouped
            title={t("mobile.connectors.page.more", { category })}
            defs={related}
            name={(d) => connectorName(t, d)}
            text={(d) => connectorDescription(t, d)}
            onOpen={(d) => openService(d.id, personal)}
            {...(def.category
              ? {
                  onAll: () =>
                    router.push({
                      pathname: "/connectors/category",
                      params: { c: def.category, ...(personal ? { personal: "1" } : {}) },
                    }),
                }
              : {})}
          />
        ) : null}
      </Animated.ScrollView>
    </View>
  );
}

/** One column of the facts: its label, an icon or a big number, and a line under it. */
function Fact({
  label,
  icon,
  value,
  sub,
  divider = false,
}: {
  label: string;
  icon?: IconName;
  value?: string;
  sub: string;
  divider?: boolean;
}) {
  const { colors: c } = useTheme();
  return (
    <View
      style={[styles.fact, divider && [styles.factLine, { borderLeftColor: c.separator }]]}
      accessible
      accessibilityLabel={[label, value, sub].filter(Boolean).join(", ")}
    >
      <Text variant="caption" tone="faint" numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.factValue}>
        {value ? (
          <Text variant="title2" tone="muted">
            {value}
          </Text>
        ) : icon ? (
          <Icon name={icon} size={22} color={c.muted} />
        ) : null}
      </View>
      <Text variant="caption" tone="faint" numberOfLines={1}>
        {sub}
      </Text>
    </View>
  );
}

/** The mark lifted off its art: a hairline and a soft shadow under it. */
const MARK_SHADOW = "0 0 0 0.5px rgba(0,0,0,0.08), 0 8px 22px -10px rgba(0,0,0,0.4)";

const styles = StyleSheet.create({
  fill: { flex: 1 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: SKY },
  hero: { alignItems: "center", gap: 2, paddingHorizontal: 16, paddingBottom: 18 },
  mark: { marginBottom: 10, borderRadius: Math.round(MARK * 0.3) },
  center: { textAlign: "center" },
  act: { alignSelf: "stretch", alignItems: "center", gap: 4, marginTop: 14 },
  button: { alignSelf: "stretch", marginTop: 8 },
  connected: { flexDirection: "row", alignItems: "center", gap: 5 },
  users: { flexDirection: "row", alignItems: "center", gap: 6 },
  faces: { flexDirection: "row", alignItems: "center" },
  over: { marginLeft: -5, borderWidth: 1.5, borderRadius: 6 },
  bold: { fontWeight: "600" },
  facts: {
    flexGrow: 0,
    marginLeft: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fact: { width: FACT, alignItems: "center", gap: 3, paddingHorizontal: 4 },
  factLine: { borderLeftWidth: StyleSheet.hairlineWidth },
  factValue: { height: 26, alignItems: "center", justifyContent: "center" },
  // The grouped lists at the screen's sides, under the strip.
  groups: { paddingHorizontal: 16, paddingTop: 10 },
});
