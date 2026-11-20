import { useApps, useMe } from "@agenteschat/client";
import { aiAppImport } from "@agenteschat/client/lib/apps";
import { errorText } from "@agenteschat/client/lib/errors";
import { stripCodeTags } from "@agenteschat/client/lib/format";
import {
  bundleOrigin,
  cardName,
  defaultMethod,
  IMPORT_CARDS,
  type ImportCard,
  type ImportMethod,
  importApplyErrorText,
  importFailureText,
  kindsLine,
  mcpClient,
  retryable,
  todoLine,
} from "@agenteschat/client/lib/import/flow";
import { EXPORT_PROMPT } from "@agenteschat/client/lib/import/index";
import { can } from "@agenteschat/client/lib/permissions";
import { helpUrl } from "@agenteschat/client/lib/server";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  ACT_LINE,
  AgentAvatar,
  Button,
  CARD_PAD,
  Card,
  Disclosure,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  Locked,
  LogoMark,
  RowPressable,
  Segmented,
  Text,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note, openPage } from "../ai/parts";
import { copyText, MONO, tapHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { fullLook } from "./edit";
import {
  agentRows,
  isRequestCard,
  kindGroups,
  pasteAction,
  phoneOffline,
  phonePicks,
  takesFiles,
  todoHref,
} from "./import";
import { IMPORT_LOGO } from "./import-logos";
import type { AgentImport } from "./useAgentImport";

/** A source's mark in its row: a list row's tile. */
const MARK = 32;

/** A source's logo on a neutral tile: our own mark for our export, an icon for any other app. */
function SourceMark({ card, size = MARK }: { card: ImportCard; size?: number }) {
  const { colors: c, scheme } = useTheme();
  const logo = card === "other" || card === "agenteschat" ? null : IMPORT_LOGO[card];
  return (
    <View
      style={[styles.tile, { width: size, height: size, backgroundColor: c.sunken, borderColor: c.line }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {logo ? (
        <Image
          source={scheme === "dark" ? (logo.dark ?? logo.light) : logo.light}
          contentFit="contain"
          style={{ width: size * 0.65, height: size * 0.65 }}
        />
      ) : card === "agenteschat" ? (
        <LogoMark size={Math.round(size * 0.6)} />
      ) : (
        <Icon name="chat" size={Math.round(size * 0.5)} color={c.muted} />
      )}
    </View>
  );
}

/**
 * "Trazer agentes de outro app", its first screen, on the grouped gray as Criar agente's steps: pick the app (its short
 * how-to under the list), then choose its files or paste its reply. What the read finds opens on a screen of its own
 * (`ImportPreview`).
 */
export function ImportPicker({ imp, orgId }: { imp: AgentImport; orgId: string }) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  const apps = useApps(orgId);
  const mine = useMe().data?.organizations.find((o) => o.id === orgId);
  const standing = mine?.standing;
  // A private repository the workspace's GitHub can't read: connecting GitHub is in Connectors, for who may.
  const mayConnect = Boolean(mine && can(mine, "manage_connectors"));
  const mcp = aiAppImport(t, apps.data, standing);
  // Prompt only for an app that takes no MCP, where MCP can't work now, or when this server's address couldn't be
  // read. Nothing to choose from while it loads, so the default never changes under the person.
  const method: ImportMethod | null =
    !imp.card || !mcpClient(imp.card)
      ? "prompt"
      : mcp
        ? ((mcp.available ? imp.methods[imp.card] : undefined) ?? defaultMethod(imp.card, mcp.available))
        : apps.isError
          ? "prompt"
          : null;
  const [text, setText] = useState("");
  const [archive, setArchive] = useState(false);
  const busy = imp.busy !== null;

  const pickFiles = async () => {
    setArchive(false);
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (res.canceled || res.assets.length === 0) return;
    const { read, archive: onlyArchives } = phonePicks(res.assets);
    if (onlyArchives) {
      setArchive(true);
      return;
    }
    void imp.read({
      files: Promise.all(
        res.assets.map(async (a, i) => ({
          name: a.name,
          text: read[i] ? await new File(a.uri).text() : "",
          ...(a.size ? { size: a.size } : {}),
        })),
      ),
    });
  };
  const submit = () => {
    const v = text.trim();
    if (!v || busy) return;
    setArchive(false);
    void imp.read(/^https?:\/\//i.test(v) ? { url: v } : { text: v });
  };

  return (
    <>
      <Locked when={busy}>
        <GroupedList>
          {IMPORT_CARDS.map((card) => {
            const on = imp.card === card;
            return (
              <GroupedRow
                key={card}
                leading={<SourceMark card={card} />}
                label={cardName(t, card)}
                checked={on}
                onPress={() => {
                  tapHaptic();
                  imp.setCard(on ? null : card);
                }}
              />
            );
          })}
        </GroupedList>
      </Locked>
      {/* Where the chosen app keeps its agents, said once under the list. */}
      {imp.card && !isRequestCard(imp.card) && method === "prompt" ? (
        <GroupedFooter>{t(`mobile.newAgent.import.where.${imp.card}`)}</GroupedFooter>
      ) : null}

      {imp.card ? <SourceSteps key={imp.card} card={imp.card} imp={imp} mcp={mcp} method={method} /> : null}

      {busy ? (
        <View style={styles.reading}>
          <ActivityIndicator color={c.muted} />
          <View style={[ACT_LINE.row, styles.line]}>
            <Text variant="body" tone="muted" style={ACT_LINE.text} accessibilityLiveRegion="polite">
              {imp.busy === "planning" ? t("onboarding.import.planning") : t("onboarding.import.reading")}
            </Text>
            <Button variant="secondary" size="sm" label={t("common.cancel")} onPress={imp.cancel} />
          </View>
        </View>
      ) : takesFiles(imp.card) && method === "prompt" ? (
        <GroupedList>
          <GroupedRow icon="file" label={t("mobile.newAgent.import.pick")} chevron onPress={() => void pickFiles()} />
        </GroupedList>
      ) : null}

      {method === "prompt" ? (
        <>
          <GroupedFooter>{t("mobile.newAgent.import.pasteTitle")}</GroupedFooter>
          <Locked when={busy}>
            <TextArea
              value={text}
              onChangeText={setText}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              placeholder={t("onboarding.import.pastePlaceholder")}
              accessibilityLabel={t("mobile.newAgent.import.pasteTitle")}
              minHeight={160}
              style={styles.paste}
            />
          </Locked>
          <View style={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              icon="copy"
              label={t("mobile.newAgent.import.paste")}
              disabled={busy}
              onPress={() =>
                void Clipboard.getStringAsync()
                  .catch(() => "")
                  .then((v) => {
                    const how = pasteAction(v);
                    if (how === "field") setText(v.trim());
                    else if (how === "read") {
                      setText("");
                      setArchive(false);
                      void imp.read({ text: v });
                    }
                  })
              }
            />
            <Button
              variant="primary"
              size="sm"
              label={t("mobile.newAgent.import.read")}
              disabled={busy || !text.trim()}
              onPress={submit}
            />
          </View>
        </>
      ) : null}

      {archive ? <ErrorText text={t("mobile.newAgent.import.archive")} /> : null}
      {imp.failure ? (
        <View style={styles.failure}>
          <ErrorText text={importFailureText(t, imp.failure, phoneOffline, mayConnect, i18n.language)} />
          {retryable(imp.failure) ? (
            <Button variant="secondary" size="sm" label={t("common.retry")} onPress={() => void imp.retry()} />
          ) : null}
        </View>
      ) : null}
      {method === "prompt" ? <Note icon="lock">{t("mobile.newAgent.import.privacy")}</Note> : null}
    </>
  );
}

/**
 * The picked source's two ways in, as on the web: MCP first where the app takes it and apps reach this server.
 * Everything the MCP steps need is copied or opened from the phone; a step that can't be done there says so in the
 * app's own notes (ChatGPT's plugins are added on the web).
 */
function SourceSteps({
  card,
  imp,
  mcp,
  method,
}: {
  card: ImportCard;
  imp: AgentImport;
  mcp: ReturnType<typeof aiAppImport>;
  method: ImportMethod | null;
}) {
  const { t } = useTranslation();
  const prompt = isRequestCard(card) ? <RequestSteps card={card} /> : null;
  if (!method) return null;
  if (!mcpClient(card) || !mcp) return prompt;
  if (!mcp.available)
    return (
      <>
        {prompt}
        <Note icon="info">{mcp.note}</Note>
      </>
    );
  return (
    <>
      <Segmented
        wide
        items={[
          { key: "mcp", label: t("onboarding.import.method.mcp") },
          {
            key: "prompt",
            label: isRequestCard(card) ? t("onboarding.import.method.prompt") : t("onboarding.import.method.file"),
          },
        ]}
        value={method}
        onChange={(m) => imp.setMethod(card, m as ImportMethod)}
      />
      {method === "mcp" ? <McpSteps card={card} imp={imp} url={mcp.url} prompt={mcp.prompt} /> : prompt}
    </>
  );
}

/** How long the MCP step waits before it says what to check when nothing came. */
const STUCK_MS = 2 * 60_000;

/** Connect the app (its own steps, shared with the web), paste the request, then the agents as they arrive. */
function McpSteps({ card, imp, url, prompt }: { card: ImportCard; imp: AgentImport; url: string; prompt: string }) {
  const { t, i18n } = useTranslation();
  const client = mcpClient(card);
  if (!client) return null;
  const guide = client.guide(url);
  const access = t("apps.consent.manage");
  // The guide's code, commands and addresses show whole, copied from under the step.
  const steps: { text: string; open?: string; copy?: string; mono?: boolean }[] = [
    ...guide.steps.map((s) => ({
      text: stripCodeTags(t(`apps.dialog.${s.text}`, { access, ...s.vars })),
      open: s.open,
      copy: s.address ? url : (s.code ?? s.vars?.command),
      mono: true,
    })),
    { text: t("onboarding.import.aiApp.paste"), copy: prompt },
  ];
  return (
    <Card>
      <View style={styles.request}>
        <Text variant="footnote" tone="muted">
          {card === "other"
            ? t("onboarding.import.aiApp.leadAny")
            : card === "chatgpt-dots"
              ? t("onboarding.import.aiApp.leadDots")
              : t("onboarding.import.aiApp.lead", { app: cardName(t, card) })}
        </Text>
        {steps.map((s, i) => (
          <View key={s.text} style={styles.step}>
            <Text variant="footnote" tone="ink2">{`${i + 1}. ${s.text}`}</Text>
            {s.open ? (
              <Button
                variant="secondary"
                size="sm"
                icon="globe"
                label={t("apps.dialog.open", { app: client.name ?? "" })}
                onPress={() => openPage(s.open as string)}
              />
            ) : null}
            {s.copy ? <CopyText text={s.copy} mono={s.mono} /> : null}
          </View>
        ))}
        {guide.notes.map((n) => (
          <Note key={n.text} icon={n.icon}>
            {stripCodeTags(t(`apps.dialog.${n.text}`))}
          </Note>
        ))}
        {card === "openbotrun" || card === "other" ? (
          <Button
            variant="secondary"
            size="sm"
            label={t("onboarding.import.aiApp.howTo")}
            onPress={() => openPage(helpUrl("apps-de-ia", i18n.language, "connect"))}
          />
        ) : null}
        <Arrivals imp={imp} />
      </View>
    </Card>
  );
}

/** Words to paste elsewhere, selectable whole, and their Copiar button. `mono`: an address or a command. */
function CopyText({ text, mono = false }: { text: string; mono?: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  return (
    <>
      <Text selectable variant="footnote" tone="ink2" style={mono ? { fontFamily: MONO } : undefined}>
        {text}
      </Text>
      <Button
        variant="secondary"
        size="sm"
        icon={copied === "ok" ? "check" : "copy"}
        label={copied === "ok" ? t("common.copied") : t("common.copy")}
        onPress={() => void copyText(text).then((ok) => setCopied(ok ? "ok" : "failed"))}
      />
      {copied === "failed" ? (
        <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite">
          {t("mobile.newAgent.import.copyFailed")}
        </Text>
      ) : null}
    </>
  );
}

/**
 * The agents the app creates, as they arrive, watched while the step shows: waiting (what to check once a while
 * passes with nothing), then each one, to its page.
 */
function Arrivals({ imp }: { imp: AgentImport }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { watch, arrived, watchError } = imp;
  useEffect(watch, [watch]);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), STUCK_MS);
    return () => clearTimeout(timer);
  }, []);
  if (watchError)
    return (
      <View style={[styles.arrivals, styles.failure]}>
        <ErrorText text={errorText(t, watchError)} />
        <Button variant="secondary" size="sm" label={t("common.retry")} onPress={imp.rewatch} />
      </View>
    );
  if (arrived.length === 0)
    return (
      <View style={styles.arrivals}>
        <View style={styles.waiting}>
          <ActivityIndicator color={c.muted} />
          <Text variant="footnote" tone="ink2" accessibilityLiveRegion="polite" style={styles.fill}>
            {t("onboarding.import.aiApp.waiting")}
          </Text>
        </View>
        {late ? (
          <Text variant="footnote" tone="muted">
            {t("onboarding.import.aiApp.stuck", { access: t("apps.consent.manage") })}
          </Text>
        ) : null}
      </View>
    );
  return (
    <View style={styles.arrivals}>
      <Text variant="footnote" style={styles.bold} accessibilityLiveRegion="polite">
        {t("onboarding.import.aiApp.arrived", { count: arrived.length })}
      </Text>
      {arrived.map((a) => (
        <RowPressable
          radius={8}
          hold
          key={a.id}
          onPress={() => router.push(`/agent/${a.id}`)}
          accessibilityRole="link"
          accessibilityLabel={a.name}
          style={styles.arrived}
        >
          <AgentAvatar agent={fullLook(a.appearance)} size={32} name={a.name} live={false} />
          <Text variant="body" style={styles.fill}>
            {a.name}
          </Text>
          <Disclosure />
        </RowPressable>
      ))}
    </View>
  );
}

/** The request to paste in Grok Bot, ChatGPT dots or any other app, and what to bring back. */
function RequestSteps({ card }: { card: "grok-bot" | "chatgpt-dots" | "other" }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const steps = [
    t("onboarding.import.request.copyStep"),
    t(`onboarding.import.request.${card}.paste`),
    t(`onboarding.import.request.${card}.back`),
  ];
  return (
    <Card>
      <View style={styles.request}>
        <Text variant="body" style={styles.bold} accessibilityRole="header">
          {t(`onboarding.import.request.${card}.title`)}
        </Text>
        {steps.map((step, i) => (
          <Text key={step} variant="footnote" tone="ink2">
            {`${i + 1}. ${step}`}
          </Text>
        ))}
        <Button
          variant="secondary"
          size="sm"
          icon={copied === "ok" ? "check" : "copy"}
          label={copied === "ok" ? t("common.copied") : t("onboarding.import.request.copy")}
          onPress={() =>
            void Clipboard.setStringAsync(EXPORT_PROMPT).then(
              () => setCopied("ok"),
              () => setCopied("failed"),
            )
          }
        />
        {copied ? (
          <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite">
            {copied === "ok" ? t(`onboarding.import.request.${card}.copied`) : t("mobile.newAgent.import.copyFailed")}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * The plan, pushed over the picker: the agents found, each to check or uncheck, then what comes with them and what
 * stays behind, as the lists' own rows. Another file or reply is the system's back away; the bar's button imports.
 */
export function ImportPreview({ imp, orgId }: { imp: AgentImport; orgId: string }) {
  const { t } = useTranslation();
  const planned = imp.planned;
  if (!planned) return null;
  const { bundle, items } = planned;
  const origin = bundleOrigin(bundle);
  const applying = imp.progress !== null;
  const pick = new Set(imp.picks);
  const agents = agentRows(bundle, items, pick, imp.blocked);
  const groups = kindGroups(items, pick, imp.blocked);
  const summary = kindsLine(t, (kind) => items.filter((i) => i.kind === kind && i.action !== "skip").length);
  const nameOf = (key: string) => bundle.agents.find((a) => a.key === key)?.name ?? key;

  return (
    <>
      {/* The name whole, on as many lines as it takes beside the source's mark. */}
      <View style={styles.previewHead}>
        <SourceMark card={origin.card} size={44} />
        <Text variant="title" accessibilityRole="header" style={styles.fill}>
          {bundle.source.name}
        </Text>
      </View>
      <Text variant="footnote" tone="muted">
        {[origin.app ? t("onboarding.import.from", { app: origin.app }) : t("onboarding.import.fromOther"), summary]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {bundle.source.ref === `agenteschat:${orgId}` ? (
        <Note icon="info">{t("onboarding.import.sameWorkspace")}</Note>
      ) : null}

      <GroupedHeader>{t("onboarding.import.groups.agent")}</GroupedHeader>
      <GroupedList>
        {agents.map((a) => {
          // A new agent says nothing: it's what every row would say.
          const status = a.status === "create" ? "" : t(`onboarding.import.status.${a.status}`);
          const why = a.reason ? t(`onboarding.import.why.${a.reason}`) : "";
          const renamed = a.wanted ? t("onboarding.import.renamed", { handle: a.handle, wanted: a.wanted }) : "";
          const note = [status, why, renamed].filter(Boolean).join(" · ");
          const sub = [a.role, !a.wanted && a.handle && `@${a.handle}`].filter(Boolean).join(" · ");
          return (
            <GroupedRow
              key={a.id}
              leading={<AgentAvatar agent={fullLook(a.appearance)} size={36} name={a.name} live={false} />}
              label={a.name}
              {...(sub ? { sub, subLines: 2 } : {})}
              {...(note ? { belowText: note } : {})}
              checked={a.free && a.on}
              faint={!a.free}
              disabled={!a.free || applying}
              onPress={() => {
                tapHaptic();
                imp.toggle([a.id], !a.on);
              }}
            />
          );
        })}
      </GroupedList>

      {groups.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.newAgent.import.also")}</GroupedHeader>
          <GroupedList>
            {groups.map((g) => {
              const label = t(`onboarding.import.report.kinds.${g.kind}`, { count: g.total });
              return g.free.length > 0 ? (
                <GroupedRow key={g.kind} label={label} toggle={g.on} onPress={() => imp.toggle(g.free, !g.on)} />
              ) : (
                <GroupedRow
                  key={g.kind}
                  label={label}
                  value={t(`onboarding.import.status.${g.coming > 0 ? "unchanged" : "skip"}`)}
                />
              );
            })}
          </GroupedList>
        </>
      ) : null}

      {bundle.todo.length > 0 ? (
        // What stays to do by hand, each a row; where the phone can do it, the row goes there.
        <>
          <View style={styles.gap} />
          <GroupedList>
            {bundle.todo.map((todo) => {
              const href = todoHref(todo.kind);
              return (
                <GroupedRow
                  key={`${todo.kind}:${todo.label}`}
                  label={todoLine(t, todo, nameOf)}
                  labelLines={0}
                  {...(href
                    ? {
                        value: t(`onboarding.import.needDo.${todo.kind as "connection" | "app" | "file"}`),
                        chevron: true,
                        disabled: applying,
                        onPress: () => router.push(href),
                      }
                    : {})}
                />
              );
            })}
          </GroupedList>
        </>
      ) : null}

      <Note icon="lock">{t("onboarding.import.never")}</Note>

      {imp.progress ? (
        <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite">
          {t("onboarding.import.applying", imp.progress)}
        </Text>
      ) : null}
      {imp.applyError ? <ErrorText text={importApplyErrorText(t, imp.applyError, phoneOffline)} /> : null}
      {!items.some((i) => i.action === "create" || i.action === "update") ? (
        <Note icon={items.every((i) => i.action === "unchanged") ? "check" : "info"}>
          {items.every((i) => i.action === "unchanged")
            ? t("onboarding.import.nothingNew")
            : t("onboarding.import.nothingToBring")}
        </Note>
      ) : null}
    </>
  );
}

function ErrorText({ text }: { text: string }) {
  const { colors: c } = useTheme();
  return (
    <Text variant="footnote" style={{ color: c.danger }} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  paste: { maxHeight: 320 },
  bold: { fontWeight: "600" },
  tile: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  reading: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  failure: { gap: 8, alignItems: "flex-start" },
  request: { gap: 8, padding: CARD_PAD, alignItems: "flex-start" },
  step: { gap: 8, alignSelf: "stretch", alignItems: "flex-start" },
  arrivals: { gap: 8, alignSelf: "stretch", marginTop: 8 },
  waiting: { flexDirection: "row", alignItems: "center", gap: 8 },
  arrived: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    borderRadius: 8,
  },
  previewHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  // Words and their button past the lead: the button under the words once they take more than their line.
  line: { flex: 1, minWidth: 0, alignItems: "center", columnGap: 16, rowGap: 8 },
  gap: { height: 14 },
});
