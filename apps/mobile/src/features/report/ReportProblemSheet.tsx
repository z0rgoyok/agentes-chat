import { type ProblemReportPlace, useProblemReportPreview, useSendProblemReport } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { problemReportCopy, problemReportError, replyAddressOk } from "@agenteschat/client/lib/problem-report";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, CodeWords, fonts, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { TextArea } from "../shared/TextArea";

/** As the server takes it (`PROBLEM_NOTE_MAX`). */
const NOTE_MAX = 2000;

export interface ReportProblemProps {
  place: ProblemReportPlace;
  code?: string | null;
  step?: string | null;
  context?: { machineId?: string; agentId?: string; runId?: string };
  timings?: Record<string, number>;
  facts?: Record<string, string | number | boolean>;
}

/**
 * The phone's "Send a report" sheet: the same as the web's dialog. What's sent is shown in full (behind "See
 * everything that's sent") before the person sends it to the agentes.chat team, or copies it.
 */
export function ReportProblemSheet({ onClose, ...props }: ReportProblemProps & { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const [input] = useState(() => ({
    orgId,
    ...props,
    client: { mobile: Constants.expoConfig?.version, locale: i18n.language },
  }));
  const preview = useProblemReportPreview(input, true);
  const send = useSendProblemReport();
  const [note, setNote] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState<"report" | "code" | null>(null);
  const data = preview.data;
  const busy = send.isPending;
  const off = data?.send === "off";
  const emailBad = !replyAddressOk(replyTo);
  const copy = (what: "report" | "code", text: string) =>
    void Clipboard.setStringAsync(text).then(() => setCopied(what));
  const sent = send.data?.id;
  const failure = send.error ? problemReportError(send.error) : null;

  if (sent) {
    return (
      <View style={styles.box}>
        <Text variant="title" selectable>
          {t("problemReport.sentTitle", { id: sent })}
        </Text>
        <Text variant="callout" tone="muted">
          {replyTo.trim() ? t("problemReport.sentTextReply", { email: replyTo.trim() }) : t("problemReport.sentText")}
        </Text>
        <Button
          variant="secondary"
          wide
          label={copied === "code" ? t("problemReport.copied") : t("problemReport.copyCode")}
          onPress={() => copy("code", sent)}
        />
        <Button variant="primary" wide label={t("problemReport.done")} onPress={onClose} />
      </View>
    );
  }

  const notes = [
    data?.missing.runnerLog === "no_answer" &&
      t("problemReport.noLogComputer", { computer: data.missing.computer ?? "" }),
    data?.missing.runnerLog === "old_app" && t("problemReport.oldRunner", { computer: data.missing.computer ?? "" }),
    data?.missing.serverLines && t("problemReport.noServerLines"),
    off && t("problemReport.off"),
  ].filter((n): n is string => Boolean(n));

  return (
    <View style={styles.box}>
      <Text variant="title">{t("problemReport.title")}</Text>
      <Text variant="callout" tone="muted">
        {t("problemReport.lead")}
      </Text>
      {preview.isPending ? (
        <Text variant="footnote" accessibilityLiveRegion="polite">
          {t("problemReport.loading")}
        </Text>
      ) : preview.error ? (
        <View style={styles.row}>
          <Text variant="footnote" tone="danger" accessibilityRole="alert">
            {t("problemReport.errorPreview", { reason: errorText(t, preview.error) })}
          </Text>
          <Button variant="text" size="sm" label={t("common.retry")} onPress={() => void preview.refetch()} />
        </View>
      ) : (
        notes.map((n) => (
          <Text key={n} variant="footnote">
            {off && n === t("problemReport.off") ? <CodeWords text={n} /> : n}
          </Text>
        ))
      )}
      <Text variant="label">{t("problemReport.noteLabel")}</Text>
      <TextArea
        value={note}
        onChangeText={setNote}
        placeholder={t("problemReport.notePlaceholder")}
        accessibilityLabel={t("problemReport.noteLabel")}
        limit={{ max: NOTE_MAX }}
        editable={!busy}
      />
      <Text variant="label">{t("problemReport.emailLabel")}</Text>
      <TextArea
        value={replyTo}
        onChangeText={setReplyTo}
        multiline={false}
        minHeight={44}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        accessibilityLabel={t("problemReport.emailLabel")}
        editable={!busy}
      />
      {emailBad ? (
        <Text variant="footnote" tone="danger">
          {t("problemReport.emailInvalid")}
        </Text>
      ) : null}
      {data && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showAll }}
            onPress={() => setShowAll(!showAll)}
            hitSlop={8}
          >
            <Text variant="subhead" tone="muted">
              {t("problemReport.showAll")}
            </Text>
          </Pressable>
          {showAll && (
            <ScrollView style={[styles.text, { backgroundColor: c.sunken }]} nestedScrollEnabled>
              <Text selectable style={styles.mono}>
                {problemReportCopy(data.text, note, replyTo)}
              </Text>
            </ScrollView>
          )}
        </>
      )}
      {failure && (
        <Text variant="footnote" tone="danger" accessibilityRole="alert">
          {t(failure.key as "problemReport.errorUnreachable", failure.params)}
        </Text>
      )}
      {!off && (
        <Button
          variant="primary"
          wide
          label={busy ? t("problemReport.sending") : t("problemReport.send")}
          loading={busy}
          disabled={!data || emailBad || note.trim().length > NOTE_MAX}
          onPress={() =>
            data &&
            send.mutate({ orgId, report: data.report, note: note.trim() || null, replyTo: replyTo.trim() || null })
          }
        />
      )}
      <Button
        variant={off ? "primary" : "secondary"}
        wide
        label={copied === "report" ? t("problemReport.copied") : t("problemReport.copy")}
        disabled={!data || busy}
        onPress={() => data && copy("report", problemReportCopy(data.text, note, replyTo))}
      />
      <Button variant="text" wide label={t("problemReport.cancel")} disabled={busy} onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12 },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  text: { maxHeight: 260, borderRadius: 12, padding: 12 },
  mono: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
});
