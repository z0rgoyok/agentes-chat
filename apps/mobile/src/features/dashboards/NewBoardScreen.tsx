import { useCreateDashboard, useMembers } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupedHeader, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { boardHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { SettingsPage, useUnsavedGuard } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { type AudienceDraft, audienceDraftOf, audienceReady, shareInputOf } from "./logic";
import { AudienceFields } from "./parts";

/** The longest name the server takes (ADR 0135). */
const TITLE_MAX = 80;

/**
 * "New dashboard", pushed (ADR 0135), on the settings' form page (a focused field clears the keyboard on both
 * systems): its name (with a line saying an agent builds one when asked in a chat; the person taps it, the keyboard
 * never comes up on its own), who sees it and who edits it. "Create" in the bar opens the new, empty board in its
 * place; leaving with a name typed asks first.
 */
export function NewBoardScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const members = useMembers(orgId);
  const create = useCreateDashboard(orgId);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState<AudienceDraft>(() => audienceDraftOf(null));
  const leave = useUnsavedGuard(title.trim() !== "");
  const ready = title.trim().length > 0 && audienceReady(draft) && !create.isPending;
  const submit = () => {
    if (!ready) return;
    const name = title.trim();
    create.mutate(
      { title: name, ...shareInputOf(draft) },
      {
        onSuccess: (board) => {
          successHaptic();
          toast({ title: t("dashboards.create.created", { title: name }) });
          leave();
          router.replace(boardHref(board.id));
        },
        onError: failed,
      },
    );
  };
  return (
    <SettingsPage
      title={t("dashboards.create.title")}
      action={{ label: t("mobile.dashboards.create"), disabled: !ready, onPress: submit }}
      locked={create.isPending}
    >
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("dashboards.create.name") }),
          text: t("dashboards.create.askHint"),
        }}
      >
        {t("dashboards.create.name")}
      </GroupedHeader>
      <TextArea
        value={title}
        onChangeText={setTitle}
        placeholder={t("dashboards.create.namePlaceholder")}
        accessibilityLabel={t("dashboards.create.name")}
        multiline={false}
        minHeight={50}
        maxLength={TITLE_MAX}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <AudienceFields draft={draft} onChange={setDraft} members={members.data?.length ?? 0} />
    </SettingsPage>
  );
}
