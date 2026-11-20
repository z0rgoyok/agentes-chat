import type { LiveKind } from "@agenteschat/client";
import { useCreateLiveFile } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Menu, MenuItem } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { markJustCreated } from "./just-created";
import { openLivePage } from "./open";

/** The kinds "New" makes, in the menu's order. */
export const NEW_KINDS: readonly LiveKind[] = ["document", "spreadsheet", "slides", "canvas"];

/**
 * Makes a live file and opens it (ADR 0196 §9, ADR 0200): an untitled document, spreadsheet, presentation or canvas, in
 * the Drive or in a conversation, whose page opens with its title selected to be named.
 */
export function useNewLiveFile(where: { channelId?: string | null; threadId?: string | null } = {}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateLiveFile(org.id);
  const make = (kind: LiveKind) => {
    if (create.isPending) return;
    create.mutate(
      { kind, title: t(`live.kinds.untitled.${kind}`), channelId: where.channelId, threadId: where.threadId },
      {
        onSuccess: (made) => {
          markJustCreated(made.id);
          openLivePage(navigate, org.id, made.id);
        },
        onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
      },
    );
  };
  return { make, busy: create.isPending, making: create.isPending ? create.variables?.kind : undefined };
}

/**
 * "New" beside Upload in the Drive (and in its empty state): a menu of the live kinds, each with its icon and one
 * quiet line on what it is for.
 */
export function NewFileMenu({
  size = "md",
  align = "end",
  iconOnly = false,
}: {
  size?: "sm" | "md";
  align?: "start" | "end";
  /** Its plus alone (a phone's header, beside Upload): "Novo" stays its name. */
  iconOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { make, busy } = useNewLiveFile();
  return (
    <Menu
      align={align}
      label={t("live.kinds.newMenu")}
      trigger={
        iconOnly ? (
          <Button
            size={size}
            icon="plus"
            iconOnly
            loading={busy}
            aria-label={t("live.kinds.new")}
            title={t("live.kinds.new")}
          />
        ) : (
          <Button size={size} icon="plus" loading={busy}>
            {t("live.kinds.new")}
          </Button>
        )
      }
    >
      {NEW_KINDS.map((kind) => (
        <MenuItem
          key={kind}
          icon={KIND_ICON[kind]}
          description={t(`live.kinds.${kind}Hint`)}
          disabled={busy}
          onSelect={() => make(kind)}
        >
          {t(`live.kinds.${kind}`)}
        </MenuItem>
      ))}
    </Menu>
  );
}
