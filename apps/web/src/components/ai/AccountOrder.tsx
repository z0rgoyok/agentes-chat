import type { AccountOrderGroup } from "@agenteschat/client";
import { useMoveAccountInOrder } from "@agenteschat/client";
import { orderAccounts, orderDrop, orderMover, orderPlaces, orderStep } from "@agenteschat/client/lib/ai-accounts";
import { errorText } from "@agenteschat/client/lib/errors";
import { HintLine, Icon, ProviderLogo } from "@agenteschat/ui";
import { type DragEvent, type HTMLAttributes, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openContextMenu } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";

/*
 * "Ordem de uso" (ADR 0041 §6) in Configurações › IA e uso: the accounts of one plan on one computer that a run goes
 * through at a limit, first to last. Whoever may move an account (its owner or an admin) drags it by its place, or
 * presses the place for Move up and Move down.
 */

const ACCOUNT_DRAG = "application/x-agentes-account";

/** The group's heading: its plan's order with what happens at a limit behind the ⓘ, and the plan's terms on a quiet line. */
export function OrderHead({ group, computer }: { group: AccountOrderGroup; computer: string | null }) {
  const { t } = useTranslation();
  const plan = t(`aiAccounts.connect.${group.kind}`);
  const title = t("usageViews.order.title", { plan });
  return (
    <div className="plan-order__head">
      {/* The plan's mark leads its heading: its rows start with their places instead. */}
      <div className="plan-order__title ac-iconline">
        <ProviderLogo id={group.kind} size="xs" />
        <HintLine name={t("common.about", { label: title })} hint={t("usageViews.order.hint")}>
          {computer ? `${title} ${t("aiAccounts.page.on", { computer })}` : title}
        </HintLine>
      </div>
      <HintLine
        className="plan-order__terms"
        name={t("common.about", { label: t("usageViews.order.termsLabel", { plan }) })}
        hint={t("usageViews.order.termsHint", { plan })}
      >
        {t("usageViews.order.terms", { plan })}
      </HintLine>
    </div>
  );
}

/**
 * Moving the accounts of `group`: `place` is a row's number (a grip for whoever may move it), blank for an account a
 * run never moves to, `drop` what makes a row with a place take a dragged account before or after it.
 */
export function useOrderMoves(orgId: string, group: AccountOrderGroup) {
  const { t } = useTranslation();
  const toast = useToast();
  const move = useMoveAccountInOrder(orgId);
  const dragging = useRef<string | null>(null);
  const [mark, setMark] = useState<{ id: string; where: "before" | "after" } | null>(null);
  // A place is an account's: the logins of one signed in once per agent move together, under one number.
  const accounts = orderAccounts(group.accounts);
  const places = orderPlaces(group.accounts);
  const blockOf = (accountId: string) => accounts.findIndex((b) => b.some((a) => a.id === accountId));
  const placeOf = (accountId: string) => places[blockOf(accountId)] ?? null;
  const put = (accountId: string, index: number | null) => {
    const n = placeOf(accountId);
    if (index === null || n === null || n - 1 === index) return;
    move.mutate(
      { accountId: orderMover(group.accounts, accountId), index },
      {
        onError: (e) => toast.show(errorText(t, e), "error"),
        // Back on the moved account's grip, whose name carries its new place: a keyboard or a screen reader stays there.
        onSuccess: () =>
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(`[data-order-grip="${CSS.escape(accountId)}"]`)?.focus(),
          ),
      },
    );
  };
  const end = () => {
    dragging.current = null;
    setMark(null);
  };

  const place = (accountId: string, name: string): ReactNode => {
    const account = group.accounts.find((a) => a.id === accountId);
    const n = placeOf(accountId);
    // No place: the slot stays, so its row starts where the numbered ones do.
    if (n === null) return <span className="plan-row__place" aria-hidden="true" />;
    if (!account?.canMove) return <span className="plan-row__place">{n}</span>;
    const label = t("usageViews.order.move", { name, n });
    return (
      <button
        type="button"
        className="plan-row__place plan-row__place--grip"
        draggable={!move.isPending}
        aria-label={label}
        aria-haspopup="menu"
        title={label}
        data-order-grip={accountId}
        // Not `disabled`: a focused button that turns disabled drops the keyboard's place on the page.
        aria-disabled={move.isPending || undefined}
        onDragStart={(e) => {
          dragging.current = accountId;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(ACCOUNT_DRAG, accountId);
          // The ghost is the row's line, not the grip alone.
          const head = e.currentTarget.parentElement?.querySelector<HTMLElement>(".plan-row__head");
          if (head) {
            const r = head.getBoundingClientRect();
            e.dataTransfer.setDragImage(head, Math.max(0, e.clientX - r.left), Math.max(0, e.clientY - r.top));
          }
        }}
        onDragEnd={end}
        onClick={(e) => {
          if (move.isPending) return;
          const r = e.currentTarget.getBoundingClientRect();
          const up = orderStep(group.accounts, accountId, -1);
          const down = orderStep(group.accounts, accountId, 1);
          openContextMenu(r.left, r.bottom, [
            { kind: "header", label: name },
            {
              kind: "item",
              id: "move-up",
              label: t("contextMenu.moveUp"),
              icon: "chevronUp",
              disabled: up === null,
              run: () => put(accountId, up),
            },
            {
              kind: "item",
              id: "move-down",
              label: t("contextMenu.moveDown"),
              icon: "chevronDown",
              disabled: down === null,
              run: () => put(accountId, down),
            },
          ]);
        }}
      >
        <span>{n}</span>
        <Icon name="grip" size={14} />
      </button>
    );
  };

  /** A row's own box: it takes an account of this order dragged onto it. */
  const drop = (accountId: string): HTMLAttributes<HTMLDivElement> & { "data-drop"?: string } =>
    placeOf(accountId) === null
      ? {}
      : {
          "data-drop": mark?.id === accountId ? mark.where : undefined,
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            const from = dragging.current;
            if (!from || from === accountId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const r = e.currentTarget.getBoundingClientRect();
            const where = e.clientY > r.top + r.height / 2 ? "after" : "before";
            if (mark?.id !== accountId || mark.where !== where) setMark({ id: accountId, where });
          },
          onDragLeave: (e: DragEvent<HTMLDivElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && mark?.id === accountId) setMark(null);
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            const from = dragging.current;
            const m = mark;
            end();
            if (!from || !m) return;
            e.preventDefault();
            put(from, orderDrop(group.accounts, from, m.id, m.where));
          },
        };

  return { place, drop };
}
