import {
  APP_OAUTH_RETURN,
  type Connection,
  type ConnectOutcome,
  type ConnectorDef,
  type CustomServer,
  type GitHubOrgAccess,
  keys,
  useCatalog,
  useCompleteOAuth,
  useConnections,
  useConnectWithKey,
  useCustomServerAction,
  useCustomServers,
  useGitHubApp,
  useGithubAccess,
  useMembers,
  useStartOAuth,
} from "@agenteschat/client";
import { composioConnectText } from "@agenteschat/client/lib/composio";
import {
  type ConnectedItem,
  connectedItems,
  connectionActs,
  isGitHostConnector,
  itemName,
  orgAccessChange,
  outcomeText,
  personalAllowed,
} from "@agenteschat/client/lib/connected";
import { sameServer } from "@agenteschat/client/lib/custom-tools";
import { knownErrorText, oauthReturnText } from "@agenteschat/client/lib/errors";
import { ownerSplit } from "@agenteschat/client/lib/owner-split";
import { can } from "@agenteschat/client/lib/permissions";
import {
  BLANK_HEADER,
  connectsWithoutKey,
  type HeaderRefused,
  type HeaderRow,
  headerRefused,
  headersToSend,
  savedHeadersUnreadable,
} from "@agenteschat/client/lib/request-headers";
import { connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { reviewDecisions, reviewToolsOf } from "@agenteschat/client/lib/tool-review";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import Animated, { Easing, FadeIn, ZoomIn } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GroupedList,
  GroupedRow,
  Icon,
  InfoHint,
  LineIcon,
  Locked,
  Segmented,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { useColors, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { errorHaptic, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { AgentLevelList, WaitTile } from "./Access";
import { ConnectorIcon } from "./ConnectorIcon";
import { useInstallGitHubAppHere } from "./GitHubApp";
import { GithubOrgs } from "./GithubOrgs";
import {
  APP_RETURN_URL,
  type AuthAnswer,
  authAnswerOf,
  capabilityLines,
  connectHow,
  connectionOf,
  doneFinishing,
  isHttpsUrl,
  markFinishing,
  needsKeyText,
  stateOf,
} from "./logic";
import { OwnClient } from "./OwnClient";
import { Problem } from "./Problem";
import { RequestHeaders } from "./RequestHeaders";
import { RoutineOfferGroup, useRoutineOffer, useStartRoutine } from "./RoutineOffer";
import { ADDRESS_STEPS, CATALOG_STEPS, doneSummary, firstStep, reviewTarget, STEP_KEYS, type Step } from "./review";
import { ReviewStep } from "./ToolReview";
import { openTools } from "./ToolsScreen";

/**
 * What every step of one connect sheet repeats over its content: the service's mark (checked once it is connected),
 * its name and the line under it, and where the step stands (`Progress`) among `steps`.
 */
interface FlowHead {
  def: ConnectorDef | null;
  image?: string | null | undefined;
  /** The mark's letter when the service has no logo. */
  label: string;
  title: string;
  subtitle?: string | undefined;
  steps: Step[];
}

/** A step's head: the service, then its step's dashes. `connected` checks the mark; `label` names a new connection. */
function StepHead({
  head,
  step,
  connected,
  label,
}: {
  head: FlowHead;
  step: Step;
  connected: boolean;
  label?: string | undefined;
}) {
  return (
    <>
      <SheetTitle
        leading={
          <ConnectorIcon def={head.def} image={head.image} label={label ?? head.label} size={52} check={connected} />
        }
        title={head.title}
        {...(head.subtitle ? { subtitle: head.subtitle } : {})}
      />
      <Progress steps={head.steps} step={step} />
    </>
  );
}

/**
 * One service in a sheet over the gallery, as on the web: what agents could do there (what always asks marked
 * "pede sua aprovação") → connect (sign in in the browser and come back, or paste a key) → a short confirmation
 * that ends it. "Ajustar" there goes on to its tools ("O que faz") and who uses it and how far. Each step is a sheet
 * over the one before (the app's sheet stack: a flick down goes back a step), never this sheet's content swapped in
 * place. A connected one opens on who uses it (its tools are a screen of their own; `item`: that connection, when the
 * service is connected more than once; `start`, back from a sign-in that finished elsewhere). `mode` starts at
 * connecting: `add`, another account of the service, or `reconnect`, a new sign-in for `item` (a toast says it, and
 * the sheet closes). `account`: GitHub's sign-in alone, without the agentes.chat app first (GitHub through the app
 * alone connecting an account). `personal`: opened from Pessoal, so a connection already there is the person's own and
 * a new one starts as theirs (who may not add the team's connects their own whatever this says). `fromPage`: opened by
 * the service's own page, which already said what agents do there: a new one goes straight to connecting.
 */
export function ConnectSheet({
  def,
  item,
  start,
  mode,
  account = false,
  personal = false,
  fromPage = false,
}: {
  def: ConnectorDef;
  item?: ConnectedItem;
  start?: Step;
  mode?: "add" | "reconnect";
  account?: boolean;
  personal?: boolean;
  fromPage?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const admin = can(org, "manage_connectors");
  const me = useMeId() ?? "";
  const mine = personal || !admin;
  const owned = ownerSplit(
    connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? [def]),
    me,
  );
  const existing = item ?? connectionOf(def, mine ? owned.mine : owned.team);
  // A new one: the team's for who manages connectors, one's own for anyone (GitHub only for the team).
  const mayConnect = existing ? connectionActs(existing, me, admin).change : admin || personalAllowed(def.id);
  const connecting = Boolean(mode) || account;
  // Where it opens, decided once: the steps after it are sheets over it.
  const [first] = useState<Step>(() =>
    connecting || (fromPage && !existing && mayConnect) ? "connect" : firstStep(existing, mayConnect, start),
  );
  const service = connectorName(t, def);
  const head: FlowHead = {
    def,
    label: service,
    title:
      mode === "reconnect" && item
        ? t("connectFlow.reconnectTitle", { name: itemName(t, item) })
        : mode === "add"
          ? t("connectFlow.addTitle", { name: service })
          : service,
    subtitle:
      def.via === "composio"
        ? `${t(`connectors.category.${def.category}`)} · ${t("connectors.composio.via")}`
        : t(`connectors.category.${def.category}`),
    steps: CATALOG_STEPS,
  };
  const flow: Flow = {
    head,
    def,
    name: service,
    item: mode ? undefined : existing,
    personal: item ? Boolean(item.ownerUserId) : existing && !mode ? Boolean(existing.ownerUserId) : mine,
  };
  if (first === "about") return <AboutStep flow={flow} mayConnect={mayConnect} />;
  if (first === "connect")
    return (
      <ConnectingStep
        flow={flow}
        item={mode ? item : undefined}
        reconnect={mode === "reconnect"}
        accountOnly={connecting}
      />
    );
  // Connected: the confirmation, its tools or who uses it, on the connection it opened for.
  if (!existing) return null;
  return <StepView flow={flow} step={first} connectionId={existing.id} />;
}

/**
 * "Conectar pelo endereço": any MCP server by its https address (sign in there, or a key when it asks). The address
 * is the first step (the one typed in the search or a card's, already in it), connecting the next, a sheet over it.
 * With an `item` of a server not in the catalog: another account of it (`add`) or a new sign-in for it (`reconnect`),
 * on its own address.
 */
export function AddressSheet({
  item,
  mode,
  url,
  personal = false,
}: {
  item?: ConnectedItem;
  mode?: "add" | "reconnect";
  url?: string;
  /** Opened from Pessoal: a new server starts as the person's own. */
  personal?: boolean;
} = {}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const head: FlowHead = {
    def: item?.def ?? null,
    image: item?.image,
    label: item?.label ?? "+",
    title:
      item && mode === "reconnect"
        ? t("connectFlow.reconnectTitle", { name: itemName(t, item) })
        : item
          ? t("connectFlow.addTitle", { name: itemName(t, item) })
          : t("mobile.connectors.addressTitle"),
    subtitle: item?.viaComposio
      ? t("connectors.composio.via")
      : (item?.server?.serverUrl ?? t("mobile.connectors.addressHelp")),
    steps: ADDRESS_STEPS,
  };
  const flow: Flow = {
    head,
    def: null,
    name: item ? itemName(t, item) : "",
    personal: item ? Boolean(item.ownerUserId) : personal || !can(org, "manage_connectors"),
  };
  if (!item) return <AddressStep flow={flow} initialUrl={url ?? ""} />;
  return <ConnectingStep flow={flow} item={item} reconnect={mode === "reconnect"} />;
}

/**
 * A server connected by its address that isn't in the catalog: its name and address, then who uses it (the same steps
 * as connecting it, each a sheet over the one before), and disconnecting it.
 */
export function ServerSheet({ item, start }: { item: ConnectedItem; start?: Step }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const me = useMeId() ?? "";
  const changes = connectionActs(item, me, can(org, "manage_connectors")).change;
  // Its tools never hold this sheet (they wait on the connection's screen): its confirmation, or who uses it.
  const [first] = useState<Step>(() =>
    firstStep(item, changes, start === "review" ? "who" : start) === "done" ? "done" : "who",
  );
  const name = itemName(t, item);
  const head: FlowHead = {
    def: item.def,
    image: item.image,
    label: name,
    title: name,
    subtitle: item.account || undefined,
    steps: ADDRESS_STEPS,
  };
  return (
    <StepView
      flow={{ head, def: item.def, name, item, personal: Boolean(item.ownerUserId) }}
      step={first}
      connectionId={item.id}
    />
  );
}

/** One connect sheet's flow, handed from step to step: its head, the service, and the connection it opened on. */
interface Flow {
  head: FlowHead;
  def: ConnectorDef | null;
  /** The service's name in the steps' words. */
  name: string;
  /** The connection as it was opened (the live lists win once they have it). */
  item?: ConnectedItem | undefined;
  /** One person's own: a new one starts there ("Para quem"), and its ending says when its agents use it. */
  personal: boolean;
}

/** The step after "Ajustar" or Continuar: a catalog service's tools come before who uses it. */
const nextOf = (flow: Flow, step: "done" | "review"): Step =>
  step === "done" && flow.head.steps.includes("review") ? "review" : "who";

/**
 * A step on a connection that exists: its confirmation, its tools or who uses it, each going on to the next as a
 * sheet over it.
 */
function StepView({ flow, step, connectionId }: { flow: Flow; step: Step; connectionId: string }) {
  const sheet = useSheet();
  const next = (from: "done" | "review") =>
    sheet.push(<StepView flow={flow} step={nextOf(flow, from)} connectionId={connectionId} />);
  return (
    <View style={styles.body}>
      <StepHead head={flow.head} step={step} connected />
      {step === "done" ? (
        <DoneStep
          connectionId={connectionId}
          def={flow.def}
          name={flow.name}
          personal={flow.personal}
          onAdjust={() => next("done")}
        />
      ) : step === "review" ? (
        <ReviewStep connectionId={connectionId} def={flow.def} name={flow.name} onNext={() => next("review")} />
      ) : (
        <WhoStep connectionId={connectionId} item={flow.item} />
      )}
    </View>
  );
}

/**
 * A catalog service's first step: what agents could do there, and Conectar (who may connect it: anyone for their own,
 * who manages connectors for the team), which goes on to connecting.
 */
function AboutStep({ flow, mayConnect }: { flow: Flow; mayConnect: boolean }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { org } = useOrg();
  const sheet = useSheet();
  const def = flow.def;
  if (!def) return null;
  const tr = t as unknown as (key: string) => string;
  const lines = capabilityLines(
    tr,
    (k) => i18n.exists(k),
    def,
    (s) => scopeText(t, s).label,
  );
  return (
    <View style={styles.body}>
      <StepHead head={flow.head} step="about" connected={false} />
      <Text variant="footnote" tone="faint" style={styles.label}>
        {t("mobile.connectors.canTitle")}
      </Text>
      <View style={styles.caps}>
        {lines.map((l) => (
          <View key={l.text} style={styles.cap}>
            <LineIcon name={l.asks ? "shield" : "eye"} size={18} color={l.asks ? c.warn : c.muted} />
            <Text variant="body" style={styles.grow}>
              {l.asks && !l.said ? t("mobile.connectors.asks", { text: l.text }) : l.text}
            </Text>
          </View>
        ))}
      </View>
      {mayConnect ? (
        <Button
          variant="primary"
          wide
          label={t("mobile.connectors.connect")}
          onPress={() => sheet.push(<ConnectingStep flow={flow} />)}
        />
      ) : (
        <Text variant="small" tone="muted">
          {/* A personal workspace's are whoever runs it, never "an admin of Personal" (ADR 0159). */}
          {t(modeKey(org, "mobile.connectors.adminsOnly"), { org: org?.name ?? "" })}
        </Text>
      )}
    </View>
  );
}

/**
 * Connecting by an address, its first step: the address (Continuar checks it), then connecting is the next step, a
 * sheet over this one, where the address shows; a flick down comes back here to change it.
 */
function AddressStep({ flow, initialUrl }: { flow: Flow; initialUrl: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const sheet = useSheet();
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const next = () => {
    const address = url.trim();
    if (!isHttpsUrl(address)) {
      errorHaptic();
      return setError(t("mobile.connectors.addressInvalid"));
    }
    setError(null);
    sheet.push(<ConnectingStep flow={flow} url={address} />);
  };
  return (
    <View style={styles.body}>
      <StepHead head={flow.head} step="connect" connected={false} />
      <View style={styles.fieldBox}>
        <Text variant="footnote" tone="faint">
          {t("mobile.connectors.addressLabel")}
        </Text>
        <TextInput
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setError(null);
          }}
          placeholder="https://"
          placeholderTextColor={c.faint}
          autoCapitalize="none"
          autoCorrect={false}
          // An address handed in (the search's, a card's) waits on Continuar, the keyboard down.
          autoFocus={!isHttpsUrl(initialUrl)}
          keyboardType="url"
          returnKeyType="next"
          onSubmitEditing={next}
          accessibilityLabel={t("mobile.connectors.addressLabel")}
          style={[styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]}
        />
      </View>
      <Button variant="primary" wide label={t("connectFlow.next")} onPress={next} />
      {error ? <Problem key={error} text={error} /> : null}
    </View>
  );
}

/**
 * Connecting, as a step of its own: the sign-in or the key (`ConnectStep`), and, once a new account is in, the
 * confirmation in its place (what the step came to, the mark checked). "Ajustar" goes on as a sheet over it.
 */
function ConnectingStep({
  flow,
  item,
  url,
  reconnect = false,
  accountOnly = false,
}: {
  flow: Flow;
  item?: ConnectedItem | undefined;
  /** The address typed on the step before. */
  url?: string;
  reconnect?: boolean;
  accountOnly?: boolean;
}) {
  const sheet = useSheet();
  const [connected, setConnected] = useState<{ id: string; name: string } | null>(null);
  const [mine, setMine] = useState(flow.personal);
  const own = item ? Boolean(item.ownerUserId) : mine;
  return (
    <View style={styles.body}>
      <StepHead
        head={flow.head}
        step={connected ? "done" : "connect"}
        connected={connected !== null}
        {...(connected && !flow.def ? { label: connected.name } : {})}
      />
      {connected ? (
        <DoneStep
          connectionId={connected.id}
          def={flow.def}
          name={flow.def ? flow.name : connected.name}
          personal={own}
          onAdjust={() =>
            sheet.push(
              <StepView
                flow={{ ...flow, ...(flow.def ? {} : { name: connected.name }), item: undefined, personal: own }}
                step={nextOf(flow, "done")}
                connectionId={connected.id}
              />,
            )
          }
        />
      ) : (
        <ConnectStep
          def={flow.def}
          name={flow.name}
          item={item}
          {...(url ? { url } : {})}
          reconnect={reconnect}
          accountOnly={accountOnly}
          personal={mine}
          onPersonal={setMine}
          onConnected={(id, name) => setConnected({ id, name })}
          onDone={sheet.close}
        />
      )}
    </View>
  );
}

/**
 * The end of connecting, as on the web: a check, "<name> conectado" and who can use it with how many actions ask,
 * then "Pronto". A server whose tools no one gave a level yet says so instead, and "Continuar" saves the levels we
 * suggest: agents get none before that. "Ajustar" goes on to the detail. A personal one says its agents use it when
 * its person asks, in their own conversation.
 */
function DoneStep({
  connectionId,
  def,
  name,
  personal,
  onAdjust,
}: {
  connectionId: string;
  def: ConnectorDef | null;
  name: string;
  personal: boolean;
  onAdjust: () => void;
}) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const orgId = useOrgId();
  const servers = useCustomServers(orgId);
  const { save } = useCustomServerAction(orgId);
  const [failed, setFailed] = useState<string | null>(null);
  const summary = doneSummary(t, reviewTarget(connectionId, def, servers.data, servers.isFetching));
  const waiting = summary?.waiting ?? null;
  // The routine it brings (ADR 0242); a server still waiting for its tools brings none yet.
  const offer = useRoutineOffer(waiting ? null : def?.id);
  const startRoutine = useStartRoutine();
  const apply = (server: CustomServer) => {
    setFailed(null);
    save.mutate(
      { id: server.id, label: server.label, tools: reviewDecisions(reviewToolsOf(t, server), {}, new Set()) },
      {
        onSuccess: () => {
          successHaptic();
          sheet.close();
        },
        onError: () => {
          errorHaptic();
          setFailed(t("mobile.connectors.review.saveFailed", { name }));
        },
      },
    );
  };
  return (
    <>
      <ConnectedNote
        name={name}
        text={
          personal && summary && !waiting
            ? t(isGitHostConnector(def?.id) ? "connectors.personal.githubDone" : "connectors.personal.done")
            : (summary?.text ?? null)
        }
      />
      {summary?.unreadable ? <Problem text={t("toolReview.unreadable", { reason: summary.unreadable })} /> : null}
      {failed ? <Problem key={failed} text={failed} /> : null}
      {summary && !waiting ? <RoutineOfferGroup offer={offer} /> : null}
      <Button
        variant="primary"
        wide
        label={waiting ? t("connectFlow.next") : t("connectFlow.done.ok")}
        disabled={!summary}
        // Done waits for the routine's rows to load: pressed now, it would make nothing.
        loading={save.isPending || (!waiting && offer.loading)}
        onPress={() => {
          if (waiting) return apply(waiting);
          startRoutine(offer);
          sheet.close();
        }}
      />
      <Button
        variant="secondary"
        wide
        label={t("connectFlow.done.adjust")}
        disabled={!summary || save.isPending}
        onPress={onAdjust}
      />
    </>
  );
}

/**
 * Who uses a connection (one row per agent, the level as its value), the last step behind "Ajustar". What a server's
 * tools need from an admin is one row there (it opens Ferramentas); anyone else is told when they still wait for an
 * admin. Ferramentas, the account and Desconectar live on its screen.
 */
function WhoStep({ connectionId, item }: { connectionId: string; item?: ConnectedItem | undefined }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const sheet = useSheet();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const me = useMeId() ?? "";
  const live =
    connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
      (i) => i.id === connectionId,
    ) ?? item;
  const admin = live ? connectionActs(live, me, can(org, "manage_connectors")).change : can(org, "manage_connectors");
  const waiting = admin && live ? live.pending : 0;
  return (
    <>
      <AgentLevelList connectionId={connectionId} personal={Boolean(live?.ownerUserId)} />
      {waiting > 0 ? (
        // What the server's tools need from the person, one tap away, never in the way of finishing.
        <GroupedList>
          <GroupedRow
            leading={<WaitTile />}
            label={t("toolReview.decideTitle", { count: waiting })}
            chevron
            onPress={() => {
              sheet.close();
              openTools(connectionId);
            }}
          />
        </GroupedList>
      ) : null}
      {live?.needsReview && !admin ? (
        <Text variant="small" tone="muted">
          {t("mobile.connectors.review.waiting")}
        </Text>
      ) : null}
      <Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />
    </>
  );
}

/** A strong ease-out: the check settles fast. */
const POP = Easing.bezier(0.23, 1, 0.32, 1);

/** Just connected: a check that pops in (the phone buzzes with it), the name and, once known, what it means. */
export function ConnectedNote({ name, text }: { name: string; text: string | null }) {
  const { t } = useTranslation();
  const { colors, reducedMotion } = useTheme();
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeIn.duration(220)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.note, styles.notice, { borderColor: colors.line }]}
    >
      <Animated.View
        // From 0.9, never from nothing; the note around it fades in with it.
        entering={
          reducedMotion
            ? undefined
            : ZoomIn.duration(240)
                .easing(POP)
                .withInitialValues({ transform: [{ scale: 0.9 }] })
        }
        style={[styles.badge, { backgroundColor: colors.ok }]}
      >
        {/* The page's own color on the green: white on dark's light green was hard to read. */}
        <Icon name="check" size={16} color={colors.bg} />
      </Animated.View>
      <View style={[styles.grow, styles.noteText]}>
        <Text variant="body" style={styles.bold}>
          {t("mobile.connectors.connectedTitle", { name })}
        </Text>
        {text ? (
          <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(160)}>
            <Text variant="small" tone="muted">
              {text}
            </Text>
          </Animated.View>
        ) : null}
      </View>
    </Animated.View>
  );
}

/**
 * Connecting: sign in in the system browser (the server hands the answer back to the app, which finishes
 * with its own session) and/or paste a key. `url`: the address typed on the step before (a server by its address).
 * `item`: an account of a server by address (its address; `reconnect`: a new sign-in for it). A new account
 * goes on (`onConnected`); a new sign-in, or the same account again, ends with a toast (`onDone`). GitHub, where
 * the server has the agentes.chat app (ADR 0156), offers the app first and an account as the other way, unless
 * `accountOnly` (a sign-in asked for as such). A server by address the catalog doesn't list also takes request headers
 * (ADR 0186), under its key: with a key or alone. Where the workspace has more than one person, a new connection asks
 * "Para quem": the person's own (Pessoal, which any member adds) or the team's (who manages connectors). Another
 * account or a new sign-in keeps its owner.
 */
function ConnectStep({
  def,
  name,
  item,
  url = "",
  reconnect = false,
  accountOnly = false,
  personal,
  onPersonal,
  onConnected,
  onDone,
}: {
  def: ConnectorDef | null;
  name: string;
  item?: ConnectedItem | undefined;
  /** The address typed on the step before. */
  url?: string;
  reconnect?: boolean;
  accountOnly?: boolean;
  /** "Para quem" on Pessoal. */
  personal: boolean;
  onPersonal: (personal: boolean) => void;
  onConnected: (connectionId: string, name: string) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const c = useColors();
  const qc = useQueryClient();
  const toast = useToast();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const servers = useCustomServers(orgId);
  const start = useStartOAuth(orgId);
  const complete = useCompleteOAuth(orgId);
  const withKey = useConnectWithKey(orgId);
  const { connect } = useCustomServerAction(orgId);
  const admin = can(org, "manage_connectors");
  const members = useMembers(orgId).data?.length ?? 0;
  const teamOnly = !personalAllowed(def?.id ?? item?.def?.id);
  const theirs = item ? Boolean(item.ownerUserId) : !teamOnly && (personal || !admin);
  const forWhom = !item && !teamOnly && members > 1;
  const mine = theirs ? { personal: true } : {};
  const fixed = item?.server?.serverUrl;
  const byAddress = fixed !== undefined || def === null || def.kind === "remote_mcp";
  const askUrl = fixed === undefined && def === null;
  // Composio's page signs in: no key field of ours.
  const viaComposio = item ? item.viaComposio : def?.via === "composio";
  const connectionId = reconnect && item?.custom ? item.id : undefined;
  const githubOrgs = reconnect && def?.id === "github" && !viaComposio && !item?.viaGithubApp;
  const access = useGithubAccess(orgId, githubOrgs);
  const githubApp = useGitHubApp(orgId);
  const installer = useInstallGitHubAppHere();
  // The app is the workspace's GitHub: a person's own account is always a sign-in.
  const appOffered =
    def?.id === "github" && !viaComposio && !accountOnly && !theirs && githubApp.data?.installable === true;
  const [via, setVia] = useState<"app" | "account">("app");
  const how = def ? connectHow(def) : "either";
  // Reconectar: the headers the account has, by name. They stay unless new ones are typed or "Remover" drops them.
  const savedHeaders = (reconnect && item?.server?.headerNames) || [];
  const canHeaders = byAddress && !viaComposio && (def === null || savedHeaders.length > 0);
  // An account with headers opens on them: they are typed with the key.
  const [mode, setMode] = useState<"signIn" | "key">(how === "key" || savedHeaders.length > 0 ? "key" : "signIn");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(savedHeaders.length > 0 ? [] : [BLANK_HEADER]);
  const [dropSaved, setDropSaved] = useState(false);
  const [headersOpen, setHeadersOpen] = useState(savedHeaders.length > 0);
  const [refused, setRefused] = useState<HeaderRefused | null>(null);
  // The saved headers couldn't be read: kept until the sheet closes, so nothing brings "they stay" back.
  const [unreadable, setUnreadable] = useState<HeaderRefused | null>(null);
  const headers = canHeaders ? headersToSend(headerRows, dropSaved) : undefined;
  const sendsHeaders = canHeaders && (headers ? headers.length > 0 : savedHeaders.length > 0);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The workspace's own OAuth app, for a server that lets in only apps it approved: who manages connectors sets it.
  const ownOffered = admin && byAddress && !viaComposio;
  const [own, setOwn] = useState(false);
  const busy = start.isPending || complete.isPending || withKey.isPending || connect.isPending || installer.busy;
  const serverUrl = fixed ?? (def?.kind === "remote_mcp" ? def.serverUrl : url.trim());
  const shownName = name || serverUrl.replace(/^https:\/\//, "").split("/")[0] || "";
  // A Telegram bot connects with the token @BotFather gives, not an API key.
  const telegram = def?.id === "telegram";
  // A git host (GitLab, Bitbucket, a git server) connects with an access token, and may run at its own address.
  const gitHost = def?.id === "gitlab" || def?.id === "bitbucket" || def?.id === "git" ? def.id : null;
  const [address, setAddress] = useState("");
  const typedAddress = def?.address ? address.trim() : "";
  const keyLabel = telegram
    ? t("connectFlow.telegram.token")
    : gitHost
      ? t("connectFlow.git.token")
      : t("mobile.connectors.keyLabel", { name: shownName });
  // The service's name: the server names another account after it ("Stripe 2"). A catalog entry's goes in English,
  // so each viewer reads a name nobody changed in their own language.
  const first = fixed ? (servers.data ?? []).find((s) => sameServer(s.serverUrl, fixed)) : undefined;
  const label = def ? def.label : first?.label || item?.label || name;

  // Every ending is felt as well as seen: a success buzz with the sheet moving on, an error buzz with the
  // reason in the sheet.
  const connected = async (id: string, shown: string, outcome: ConnectOutcome = "connected") => {
    successHaptic();
    if (outcome === "connected") return onConnected(id, shown || shownName);
    const orgsBefore = githubOrgs ? qc.getQueryData<GitHubOrgAccess>(keys.githubAccess(orgId))?.orgs : null;
    const orgsNow = orgsBefore ? await access.refetch().then((r) => r.data?.orgs) : null;
    // The lists were read again on the way back: the account's own name and whether its provider named it.
    const now = connectedItems(
      qc.getQueryData<Connection[]>(keys.connections(orgId)) ?? [],
      qc.getQueryData<CustomServer[]>(keys.customServers(orgId)) ?? [],
      catalog.data?.connectors ?? [],
    ).find((i) => i.id === id);
    const said = now ? outcomeText(t, outcome, now) : t("mobile.connectors.connectedDone");
    toast({
      title:
        orgsBefore && orgsNow
          ? t("common.joinSentences", { a: said, b: orgAccessChange(t, orgsBefore, orgsNow) })
          : said,
    });
    onDone();
    // Landed on another connection (a catalog connector's new sign-in is a new one): the screen behind follows it.
    if (item && id !== item.id) router.replace(`/connectors/${id}`);
  };
  const oops = (text: string) => {
    errorHaptic();
    setError(text);
  };
  const fail = (error?: unknown) => oops(knownErrorText(t, error) ?? t("mobile.connectors.failed"));
  /** A failed connect by address: the server refusing a header says so where the headers are, whichever way in. */
  const failed = (error: unknown) => {
    const refusal = headerRefused(headerRows, headers, error);
    if (!refusal) return fail(error);
    errorHaptic();
    setMode("key");
    setHeadersOpen(true);
    // Its words stand where the saved names were said to stay. Nothing is removed for the person: connecting again
    // is refused again until they type the headers or choose Remover.
    // With no saved names in this form (its list is older than the account's headers) they have no line to stand in:
    // they show under the rows, as any refusal does.
    if (savedHeadersUnreadable(error) && savedHeaders.length > 0) setUnreadable(refusal);
    else setRefused(refusal);
  };
  /** The browser round trip: open, wait for the answer, finish with the app's session. */
  const signInWith = async (authorizeUrl: string) => {
    const state = stateOf(authorizeUrl);
    if (state) markFinishing(state);
    try {
      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, APP_RETURN_URL);
      if (result.type !== "success") return;
      const answer: AuthAnswer | null = authAnswerOf(result.url);
      if (!answer) return fail();
      if (answer.kind === "error") {
        // A connector's own refusal (Composio's unfinished sign-in) comes as its full code.
        const own = answer.error.startsWith("connector.") ? oauthReturnText(t, answer.error) : null;
        return oops(own ?? t("mobile.connectors.refused", { name: shownName }));
      }
      const done = await complete.mutateAsync({ state: answer.state, code: answer.code });
      await connected(done.connectionId, name, done.outcome);
    } catch (error) {
      fail(error);
    } finally {
      if (state) doneFinishing(state);
    }
  };

  /** With no key: the server's own sign-in, or, with request headers, the headers alone. */
  const signIn = async () => {
    setError(null);
    setRefused(null);
    if (askUrl && !isHttpsUrl(url)) return oops(t("mobile.connectors.addressInvalid"));
    try {
      if (byAddress) {
        const res = await connect.mutateAsync({
          serverUrl,
          returnTo: APP_OAUTH_RETURN,
          ...(label ? { label } : {}),
          ...(connectionId ? { connectionId } : {}),
          ...(headers ? { headers } : {}),
          ...mine,
        });
        if (res.status === "oauth") return void (await signInWith(res.authorizeUrl));
        if (res.status === "needs_key") {
          const ownWay = ownOffered && res.reason === "not_approved";
          if (ownWay) setOwn(true);
          else setMode("key");
          // "Check their values": the headers it sent are in sight.
          if (sendsHeaders) setHeadersOpen(true);
          return oops(needsKeyText(t, res, shownName, sendsHeaders, ownWay));
        }
        return await connected(res.server.id, res.server.label, res.outcome);
      }
      if (!def) return;
      const authorizeUrl = await start.mutateAsync({ connector: def.id, returnTo: APP_OAUTH_RETURN, ...mine });
      await signInWith(authorizeUrl);
    } catch (error) {
      failed(error);
    }
  };

  const submitKey = async () => {
    // Headers alone connect, and an account's saved ones are removed with no key: with none typed there is none to
    // check or to send.
    if (canHeaders && connectsWithoutKey(headers, savedHeaders) && key.trim() === "") return signIn();
    setError(null);
    setRefused(null);
    if (askUrl && !isHttpsUrl(url)) return oops(t("mobile.connectors.addressInvalid"));
    if (def?.address && (typedAddress ? !isHttpsUrl(typedAddress) : def.address === "required")) {
      return oops(t("mobile.connectors.addressInvalid"));
    }
    if (key.trim().length < 8) return oops(t("mobile.connectors.keyShort"));
    try {
      if (byAddress) {
        const res = await connect.mutateAsync({
          serverUrl,
          apiKey: key.trim(),
          returnTo: APP_OAUTH_RETURN,
          ...(label ? { label } : {}),
          ...(connectionId ? { connectionId } : {}),
          ...(headers ? { headers } : {}),
          ...mine,
        });
        if (res.status === "connected") return await connected(res.server.id, res.server.label, res.outcome);
        return fail();
      }
      if (!def) return;
      const conn = await withKey.mutateAsync({
        connector: def.id,
        apiKey: key.trim(),
        ...(typedAddress ? { serverUrl: typedAddress } : {}),
        ...mine,
      });
      // One account per catalog connector: connecting it again is its new sign-in.
      await connected(conn.id, name, reconnect ? "reconnected" : "connected");
    } catch (error) {
      failed(error);
    }
  };

  const installApp = async () => {
    setError(null);
    const done = await installer.run();
    if (done.installed) onDone();
    else if (done.error) oops(done.error);
  };
  const field = [styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  if (own) {
    // A one-click server whose vendor's steps we know (Meta Ads, where this server has no Meta app of its own).
    const preset = catalog.data?.connectors.find((d) => d.kind === "remote_mcp" && sameServer(d.serverUrl, serverUrl));
    return (
      <>
        {error ? <Problem key={error} text={error} /> : null}
        <OwnClient
          serverUrl={serverUrl}
          guide={preset?.id === "meta-ads" ? t("connectFlow.ownClient.guide.metaAds") : null}
          busy={busy}
          onSaved={() => {
            setOwn(false);
            void signIn();
          }}
        />
        <Button
          variant="text"
          size="sm"
          label={t("mobile.connectors.useSignIn")}
          disabled={busy}
          onPress={() => {
            setError(null);
            setOwn(false);
          }}
        />
      </>
    );
  }
  if (appOffered && via === "app") {
    return (
      <>
        <Text variant="small" tone="muted">
          {t("connectFlow.github.appText")}
        </Text>
        <Button
          variant="primary"
          wide
          label={t("githubApp.install")}
          loading={busy}
          onPress={() => void installApp()}
        />
        <Button
          variant="text"
          size="sm"
          label={t("mobile.connectors.githubApp.useAccount")}
          disabled={busy}
          onPress={() => {
            setError(null);
            setVia("account");
          }}
        />
        {error ? <Problem key={error} text={error} /> : null}
      </>
    );
  }
  return (
    <>
      {forWhom ? (
        <Locked when={busy} style={styles.fieldBox}>
          <Text variant="footnote" tone="faint">
            {t("connectors.personal.forWhom")}
          </Text>
          <Segmented
            wide
            items={[
              { key: "personal", label: t("vault.tab.personal") },
              { key: "team", label: t(modeKey(org, "vault.tab.team")), disabled: !admin },
            ]}
            value={theirs ? "personal" : "team"}
            onChange={(k) => onPersonal(k === "personal")}
          />
          {admin ? null : <Note icon="lock">{t("connectors.personal.teamLocked")}</Note>}
        </Locked>
      ) : null}
      {viaComposio && def ? (
        <Text variant="small" tone="muted">
          {composioConnectText(t, def)}
        </Text>
      ) : appOffered ? (
        <Text variant="small" tone="muted">
          {t("connectFlow.github.accountText")}
        </Text>
      ) : def?.id === "x" ? (
        // X wants the account owner's express consent before agents post for them: connecting after this is it.
        <Text variant="small" tone="muted">
          {t("connectFlow.x.consent")}
        </Text>
      ) : null}
      {askUrl ? (
        // The address it will enter, typed on the step before (a flick down goes back to change it).
        <Text variant="footnote" tone="faint" numberOfLines={1}>
          {serverUrl}
        </Text>
      ) : null}
      {githubOrgs ? <GithubOrgs /> : null}
      {mode === "signIn" ? (
        <Button
          variant="primary"
          wide
          label={viaComposio ? t("connectFlow.continueInComposio") : t("mobile.connectors.signIn", { name: shownName })}
          loading={busy}
          onPress={() => void signIn()}
        />
      ) : (
        <>
          {def?.address && gitHost ? (
            <Locked when={busy} style={styles.fieldBox}>
              <InfoHint
                name={t("common.about", { label: t("connectFlow.git.address") })}
                text={t(`connectFlow.git.addressHelp.${gitHost === "git" ? "git" : "gitlab"}`)}
                variant="footnote"
              >
                <Text variant="footnote" tone="faint">
                  {t("connectFlow.git.address")}
                </Text>
              </InfoHint>
              <TextInput
                value={address}
                onChangeText={setAddress}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={def.address === "optional" ? "https://gitlab.com" : "https://"}
                accessibilityLabel={t("connectFlow.git.address")}
                style={field}
              />
            </Locked>
          ) : null}
          <Locked when={busy} style={styles.fieldBox}>
            <InfoHint
              name={t("common.about", { label: keyLabel })}
              text={
                telegram
                  ? t("connectFlow.telegram.steps")
                  : gitHost
                    ? t(`connectFlow.git.tokenHelp.${gitHost}`)
                    : t("mobile.connectors.keyHelp")
              }
              variant="footnote"
            >
              <Text variant="footnote" tone="faint">
                {keyLabel}
              </Text>
            </InfoHint>
            <View style={styles.keyRow}>
              <TextInput
                value={key}
                onChangeText={setKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={keyLabel}
                style={[field, styles.grow]}
              />
              <Button
                variant="secondary"
                size="sm"
                label={t("mobile.connectors.paste")}
                onPress={() => void Clipboard.getStringAsync().then((v) => setKey(v.trim()))}
              />
            </View>
          </Locked>
          {canHeaders ? (
            <Locked when={busy}>
              <RequestHeaders
                rows={headerRows}
                saved={savedHeaders}
                dropSaved={dropSaved}
                open={headersOpen}
                refused={refused}
                unreadable={unreadable}
                onOpen={setHeadersOpen}
                onChange={(rows, drop) => {
                  setHeaderRows(rows);
                  setDropSaved(drop);
                  setRefused(null);
                }}
              />
            </Locked>
          ) : null}
          <Button
            variant="primary"
            wide
            label={t("mobile.connectors.connect")}
            loading={busy}
            onPress={() => void submitKey()}
          />
        </>
      )}
      {/* The other way in, as words under the button, only where both exist (a server asked for a key). */}
      {!viaComposio && (how === "either" || (byAddress && mode === "key")) ? (
        <Button
          variant="text"
          size="sm"
          label={mode === "signIn" ? t("mobile.connectors.useKey") : t("mobile.connectors.useSignIn")}
          disabled={busy}
          onPress={() => setMode(mode === "signIn" ? "key" : "signIn")}
        />
      ) : null}
      {ownOffered && (!askUrl || isHttpsUrl(url)) ? (
        <Button
          variant="text"
          size="sm"
          label={t("connectFlow.ownClient.title")}
          disabled={busy}
          onPress={() => {
            setError(null);
            setOwn(true);
          }}
        />
      ) : null}
      {appOffered ? (
        <Button
          variant="text"
          size="sm"
          label={t("mobile.connectors.githubApp.useApp")}
          disabled={busy}
          onPress={() => {
            setError(null);
            setVia("app");
          }}
        />
      ) : null}
      {error ? <Problem key={error} text={error} /> : null}
    </>
  );
}

/** One dash per step, the ones done and the current in ink, and the step said under them ("Passo 2 de 2: …"). */
export function Progress({ steps, step }: { steps: Step[]; step: Step }) {
  const { t } = useTranslation();
  const c = useColors();
  if (step === "done") return null;
  const index = steps.indexOf(step);
  const said = t("mobile.connectors.step", { n: index + 1, total: steps.length, label: t(STEP_KEYS[step]) });
  return (
    <View accessible accessibilityLabel={said} style={styles.steps}>
      <View style={styles.progress}>
        {steps.map((s, i) => (
          <View key={s} style={[styles.dash, { backgroundColor: i <= index ? c.ink : c.line2 }]} />
        ))}
      </View>
      <Text variant="footnote" tone="faint" style={styles.bold}>
        {said}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  label: { letterSpacing: 0.3 },
  caps: { gap: 10 },
  cap: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  steps: { gap: 8 },
  progress: { flexDirection: "row", gap: 6 },
  dash: { flex: 1, height: 3, borderRadius: 999 },
  fieldBox: { gap: 6 },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...fieldText("body"),
  },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  // A neutral card with a colored badge: the outcome of connecting (`Problem` draws what went wrong the same). The
  // words wrap: their first line sits at the badge's middle, the badge never in the middle of the words.
  notice: {
    alignItems: "flex-start",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  // The title's line (22) at the badge's (28) middle.
  noteText: { paddingTop: 3 },
});
