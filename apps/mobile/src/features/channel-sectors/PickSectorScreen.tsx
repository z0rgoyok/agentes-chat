import { type Channel, useChannels, useSetSidebarView, useSidebarView } from "@agenteschat/client";
import {
  addSection,
  moveChannelBy,
  placeInSection,
  SIDEBAR_SECTION_NAME_MAX,
  sectionOfChannel,
} from "@agenteschat/client/lib/sidebar-view";
import { useTranslation } from "react-i18next";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId } from "../shared/hooks";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";

/** A section's channels, for the line under it ("#bugs, #tech, #deploys"). */
function channelLine(channels: readonly Channel[], ids: readonly string[], except: string) {
  return ids
    .filter((id) => id !== except)
    .flatMap((id) => channels.find((c) => c.id === id) ?? [])
    .map((c) => `#${c.name}`)
    .join(", ");
}

/**
 * "Seção" of a channel (ADR 0260), from its ⋯ sheet or a long press on the home, as the web's "Mover para a seção":
 * the person's own sections, each with its channels, and "Sem seção", the current one checked; a tap moves it and
 * goes back. "Nova seção" names one in a sheet and takes the channel along. Below, its place in its section, one step
 * up or down. Each person's own: nobody else's list changes.
 */
export function PickSectorScreen({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const channels = useChannels(orgId);
  const view = useSidebarView(orgId);
  const setView = useSetSidebarView(orgId);
  const sections = view.sections ?? [];
  const channel = channels.data?.find((c) => c.id === channelId);
  const all = channels.data ?? [];
  const current = sectionOfChannel(sections, channelId);
  const mine = sections.find((s) => s.id === current)?.channelIds ?? [];
  const at = mine.indexOf(channelId);
  const pick = (sectionId: string | null) => {
    if (sectionId !== current) {
      setView((now) => ({ ...now, sections: placeInSection(now.sections ?? [], channelId, sectionId) }));
      successHaptic();
    }
    router.back();
  };
  const step = (delta: -1 | 1) =>
    setView((now) => ({ ...now, sections: moveChannelBy(now.sections ?? [], channelId, delta) }));
  const create = () =>
    sheet.open(
      <PromptForm
        leading={<Tile icon="list" size={40} />}
        title={t("sidebarSections.new")}
        placeholder={t("sidebarSections.nameLabel")}
        submitLabel={t("sidebarSections.new")}
        limit={{ max: SIDEBAR_SECTION_NAME_MAX, fix: t("mobile.sections.tooLong") }}
        onSubmit={(name) => {
          setView((now) => ({ ...now, sections: addSection(now.sections ?? [], name, [channelId]).sections }));
          successHaptic();
          sheet.close();
          router.back();
        }}
      />,
    );
  return (
    <SettingsPage title={t("mobile.sections.title")} {...(channel ? { subtitle: `#${channel.name}` } : {})}>
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("mobile.sections.where", { channel: channel?.name ?? "" }) }),
          text: t("mobile.sections.whereHelp"),
        }}
      >
        {t("mobile.sections.where", { channel: channel?.name ?? "" })}
      </GroupedHeader>
      {channels.data ? (
        <GroupedList>
          <GroupedRow label={t("mobile.sections.none")} checked={current === null} onPress={() => pick(null)} />
          {sections.map((s) => (
            <GroupedRow
              key={s.id}
              label={s.name}
              {...(channelLine(all, s.channelIds, channelId) ? { sub: channelLine(all, s.channelIds, channelId) } : {})}
              checked={current === s.id}
              onPress={() => pick(s.id)}
            />
          ))}
        </GroupedList>
      ) : channels.isError ? (
        <LoadFailed onRetry={() => void channels.refetch()} />
      ) : (
        <SkeletonList rows={3} />
      )}
      {channel ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow icon="plus" label={t("sidebarSections.new")} chevron onPress={create} />
          </GroupedList>
        </>
      ) : null}
      {channel && current ? (
        <>
          <GroupedHeader>{t("mobile.sections.order")}</GroupedHeader>
          <GroupedList>
            <GroupedRow label={t("mobile.categories.up")} disabled={at <= 0} onPress={() => step(-1)} />
            <GroupedRow label={t("mobile.categories.down")} disabled={at >= mine.length - 1} onPress={() => step(1)} />
          </GroupedList>
          <GroupedFooter>{t("mobile.categories.channelPosition", { at: at + 1, count: mine.length })}</GroupedFooter>
        </>
      ) : null}
    </SettingsPage>
  );
}
