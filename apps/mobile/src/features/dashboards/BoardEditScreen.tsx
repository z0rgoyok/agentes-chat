import { type Dashboard, useDashboard, useUpdateDashboard } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupedHeader, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { NEXT_FIELD, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { MissingScreen } from "./parts";

/** The longest name and description the server takes (ADR 0135). */
const TITLE_MAX = 80;
const ABOUT_MAX = 280;

/**
 * "Rename" a dashboard, pushed from its "…" (ADR 0135): its name and what it is for, on the settings' form page (the
 * fields clear the keyboard on both systems, the name's return goes to the description). "Save" in the bar; leaving
 * with changes asks first.
 */
export function BoardEditScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const q = useDashboard(useOrgId(), id);
  if (!q.data)
    return (
      <MissingScreen
        title={t("dashboards.rename")}
        state={q.isLoading ? "loading" : q.isError ? "failed" : "gone"}
        onRetry={() => void q.refetch()}
        gone={t("dashboards.errors.notFound")}
      />
    );
  return <Form key={q.data.id} board={q.data} />;
}

function Form({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = useFailed();
  const update = useUpdateDashboard(useOrgId());
  const [title, setTitle] = useState(board.title);
  const [about, setAbout] = useState(board.about);
  const changed = title.trim() !== board.title || about.trim() !== board.about;
  const leave = useUnsavedGuard(changed);
  const ready = title.trim().length > 0 && !update.isPending;
  const save = () => {
    if (!ready) return;
    if (!changed) {
      goBack();
      return;
    }
    update.mutate(
      { dashboardId: board.id, title: title.trim(), about: about.trim() },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("mobile.dashboards.edit.saved") });
          leave();
          goBack();
        },
        onError: failed,
      },
    );
  };
  return (
    <SettingsPage
      title={t("dashboards.rename")}
      action={{ label: t("common.save"), disabled: !ready, onPress: save }}
      locked={update.isPending}
      toolbar
    >
      <GroupedHeader>{t("dashboards.create.name")}</GroupedHeader>
      <TextArea
        value={title}
        onChangeText={setTitle}
        placeholder={t("dashboards.create.namePlaceholder")}
        accessibilityLabel={t("dashboards.create.name")}
        multiline={false}
        minHeight={50}
        maxLength={TITLE_MAX}
        {...NEXT_FIELD}
      />
      <GroupedHeader>{t("dashboards.about")}</GroupedHeader>
      <TextArea
        value={about}
        onChangeText={setAbout}
        placeholder={t("dashboards.aboutPlaceholder")}
        accessibilityLabel={t("dashboards.about")}
        maxLength={ABOUT_MAX}
        minHeight={96}
      />
    </SettingsPage>
  );
}
