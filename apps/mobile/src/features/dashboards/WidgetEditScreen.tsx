import { useUpdateWidget, useWidget, type WidgetDetail } from "@agenteschat/client";
import { WIDGET_LIMITS } from "@agenteschat/ui/widgets/spec";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { Gap, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { MissingScreen } from "./parts";

/** The longest alert condition the server takes (ADR 0135). */
const CONDITION_MAX = 200;

/** What a widget's screen changes on a screen of its own: its title, or its alert and condition. */
export type WidgetField = "title" | "alert";

/** A widget's field to change, pushed from its screen (`/widget-edit/<id>?field=`). */
export const widgetEditHref = (id: string, field: WidgetField) => `/widget-edit/${id}?field=${field}` as const;

/**
 * A widget's title or its alert, pushed from its screen (screens, never a form opened in place inside a card): the
 * field on the grouped gray and "Salvar" in the bar, which goes back once it took. A person's title is kept: the agent
 * no longer renames the widget. The keyboard comes up when the person taps the field; leaving with changes asks first.
 */
export function WidgetEditScreen({ id, field }: { id: string; field: WidgetField }) {
  const { t } = useTranslation();
  const q = useWidget(useOrgId(), id);
  const title = field === "alert" ? t("mobile.dashboards.notice.card.alert") : t("mobile.dashboards.widget.title");
  if (!q.data)
    return (
      <MissingScreen
        title={title}
        state={q.isLoading ? "loading" : q.isError ? "failed" : "gone"}
        onRetry={() => void q.refetch()}
        gone={t("dashboards.errors.widgetNotFound")}
      />
    );
  return field === "alert" ? (
    <AlertForm key={q.data.id} widget={q.data} title={title} />
  ) : (
    <TitleForm key={q.data.id} widget={q.data} title={title} />
  );
}

/**
 * The screen both forms stand on: the settings' form page (the bar with "Salvar", the grouped gray, a field that clears
 * the keyboard on both systems).
 */
function FormPage({
  title,
  ready,
  busy,
  onSave,
  children,
}: {
  title: string;
  ready: boolean;
  busy: boolean;
  onSave: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SettingsPage title={title} action={{ label: t("common.save"), disabled: !ready, onPress: onSave }} locked={busy}>
      {children}
    </SettingsPage>
  );
}

/** The widget's title: the field, filled with the title it has now. */
function TitleForm({ widget: w, title: screenTitle }: { widget: WidgetDetail; title: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = useFailed();
  const update = useUpdateWidget(useOrgId());
  const [title, setTitle] = useState(w.title);
  const next = title.trim();
  const leave = useUnsavedGuard(next !== w.title);
  const ready = next.length > 0 && !update.isPending;
  const save = () => {
    if (!ready) return;
    if (next === w.title) {
      goBack();
      return;
    }
    update.mutate(
      { widgetId: w.id, title: next },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("mobile.dashboards.widget.titleSaved") });
          leave();
          goBack();
        },
        onError: failed,
      },
    );
  };
  return (
    <FormPage title={screenTitle} ready={ready} busy={update.isPending} onSave={save}>
      <Gap />
      <TextArea
        value={title}
        onChangeText={setTitle}
        placeholder={t("mobile.dashboards.widget.titlePlaceholder")}
        accessibilityLabel={t("mobile.dashboards.widget.title")}
        multiline={false}
        minHeight={50}
        maxLength={WIDGET_LIMITS.title}
        returnKeyType="done"
        onSubmitEditing={save}
      />
    </FormPage>
  );
}

/** The widget's alert: on or off, and when on, what it watches for ("algo fugir do normal" when left empty). */
function AlertForm({ widget: w, title }: { widget: WidgetDetail; title: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = useFailed();
  const update = useUpdateWidget(useOrgId());
  const [on, setOn] = useState(w.alert.enabled);
  const [condition, setCondition] = useState(w.alert.condition);
  const next = { enabled: on, condition: on ? condition.trim() : "" };
  const changed = next.enabled !== w.alert.enabled || next.condition !== w.alert.condition.trim();
  const leave = useUnsavedGuard(changed);
  const ready = !update.isPending;
  const save = () => {
    if (!ready) return;
    if (!changed) {
      goBack();
      return;
    }
    update.mutate(
      { widgetId: w.id, alert: next },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("mobile.dashboards.widget.alertSaved") });
          leave();
          goBack();
        },
        onError: failed,
      },
    );
  };
  return (
    <FormPage title={title} ready={ready} busy={update.isPending} onSave={save}>
      <Gap />
      <GroupedList>
        <GroupedRow label={t("widgets.alert.label")} labelLines={2} toggle={on} onPress={() => setOn((v) => !v)} />
      </GroupedList>
      <GroupedFooter>{t("widgets.alert.hint")}</GroupedFooter>
      {on ? (
        <>
          <GroupedHeader>{t("widgets.alert.condition")}</GroupedHeader>
          <TextArea
            value={condition}
            onChangeText={setCondition}
            placeholder={t("widgets.alert.placeholder")}
            accessibilityLabel={t("widgets.alert.condition")}
            multiline={false}
            minHeight={50}
            maxLength={CONDITION_MAX}
            returnKeyType="done"
            onSubmitEditing={save}
          />
        </>
      ) : null}
    </FormPage>
  );
}
