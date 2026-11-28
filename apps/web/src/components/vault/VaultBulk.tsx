import type { VaultAccess, VaultItem, VaultScope } from "@agenteschat/client";
import { useVaultBulk } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogBody, DialogFooter, Locked } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { AccessBlock } from "./VaultAccess";

/*
 * Many Vault items chosen at once (ADR 0144): one access for all of them, or deleting them, in one call each. What
 * the server leaves (a password manager's items still there) is said in the toast after.
 */

function useBulk(onDone: () => void) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const bulk = useVaultBulk(org.id);
  const run = (action: Parameters<typeof bulk.mutate>[0], done: (count: number, kept: number) => string) =>
    bulk.mutate(action, {
      onSuccess: (r) => {
        toast.show(done(r.count, r.kept));
        onDone();
      },
      onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
    });
  return { run, busy: bulk.isPending };
}

/** Who has access to the chosen items: it starts as the first one's, and Apply gives it to every one. */
export function VaultBulkAccessDialog({
  scope,
  items,
  onClose,
  onDone,
}: {
  scope: VaultScope;
  items: VaultItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [access, setAccess] = useState<VaultAccess>(() => (items[0] as VaultItem).access);
  const { run, busy } = useBulk(onDone);
  const apply = () =>
    run({ type: "access", ids: items.map((i) => i.id), access }, (count) => t("vault.bulk.accessDone", { count }));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("vault.bulk.accessTitle", { count: items.length })}
      description={t("vault.bulk.accessText")}
      closeLabel={t("common.close")}
      width={480}
    >
      <Locked when={busy}>
        <DialogBody>
          <AccessBlock
            scope={scope}
            access={access}
            editable
            onChange={(next) => {
              setAccess(next);
              return true;
            }}
          />
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={busy} disabled={busy} onClick={apply}>
          {t("vault.bulk.accessGo", { count: items.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function VaultBulkDeleteDialog({
  items,
  onClose,
  onDone,
}: {
  items: VaultItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { run, busy } = useBulk(onDone);
  const remove = () =>
    run({ type: "delete", ids: items.map((i) => i.id) }, (count, kept) =>
      [t("vault.bulk.deleted", { count }), kept > 0 ? t("vault.bulk.kept", { count: kept }) : ""]
        .filter(Boolean)
        .join(" "),
    );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("vault.bulk.deleteTitle", { count: items.length })}
      description={t("vault.bulk.deleteText")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" loading={busy} disabled={busy} onClick={remove}>
          {t("vault.bulk.deleteGo", { count: items.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
