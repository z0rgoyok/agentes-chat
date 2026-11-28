import {
  keys,
  type SurfaceLink,
  type SurfaceLinks,
  useAgents,
  useConfirmSurfaceLink,
  useRemoveSurfaceLink,
  useSetSurfaceNudge,
  useSetSurfacePin,
  useSurfaceLinks,
} from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { isHttpsUrl } from "@agenteschat/client/lib/custom-tools";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { rightHandName } from "@agenteschat/client/lib/right-hand";
import {
  CODE_TTL_MS,
  codeDeadline,
  DAY_HOURS,
  hourLabel,
  LINK_POLL_MS,
  NUDGE_AFTER_HOURS,
  newlyLinked,
  pinChosen,
  pinMismatch,
  RENEW_BEFORE_MS,
  surfaceMarkUrl,
  surfaceRowOf,
} from "@agenteschat/client/lib/surface-links";
import { formatPhone } from "@agenteschat/i18n/format";
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  PixelSpinner,
  QrCode,
  Select,
  Switch,
  useNow,
} from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { Step } from "@/components/devices/Step";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { PinFields } from "@/components/PinFields";
import { useImageLoads } from "@/hooks/useImageLoads";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";

/** Refusals a fresh code gets past: the link ran out, was canceled, or its sender belongs to someone else. */
const NEW_CODE_FIXES = new Set(["surface.link_gone", "surface.code_gone", "surface.taken"]);
/** Refusals to make a code that a retry can't get past: the way out is elsewhere, so the dialog offers Close. */
const MINT_FINAL = new Set(["surface.off", "surface.not_allowed", "surface.no_assistant", "surface.no_workspace"]);

/**
 * The surface's mark as one of the kit's glyphs: the `Icon` box at `size`, in the text's color, the brand's logo
 * inside the kit's 20 grid where its strokes sit (3 clear on each side), so it weighs what the glyphs beside it do. A
 * plain chat glyph while the logo loads, or when the surface's name names no file.
 */
export function SurfaceMark({ name, size = 16 }: { name: string; size?: 14 | 16 }) {
  const url = surfaceMarkUrl(name);
  const loads = useImageLoads(url);
  const mask = `surface-mark-${useId().replace(/[^\w-]/g, "")}`;
  if (!loads || !url) return <Icon name="message" size={size} />;
  return (
    <svg
      viewBox="0 0 20 20"
      className="ac-icon"
      style={{ width: size, height: size }}
      aria-hidden="true"
      focusable="false"
    >
      <mask id={mask} style={{ maskType: "alpha" }}>
        <image href={url} x="3" y="3" width="14" height="14" />
      </mask>
      <rect width="20" height="20" fill="currentColor" stroke="none" mask={`url(#${mask})`} />
    </svg>
  );
}

/**
 * The built-in assistant of workspace `orgId` by name, the generic words only once its agents loaded without one, null
 * while they load: the consent line records this name, so it never shows a stand-in that may change.
 */
function useAssistantName(orgId: string): string | null {
  const { t } = useTranslation();
  const agents = useAgents(orgId).data;
  return agents ? (rightHandName(agents) ?? t("rightHand.labelCapitalized")) : null;
}

/**
 * Settings › Notifications › Where they arrive (ADR 0187): the outside chat surface, only for an account the server
 * lets link it. None: Link. A sender waiting on the person's confirm: the line opens the dialog at that step. Linked:
 * the sender as the surface shows it, with its PIN (ADR 0226; `?pin=1`, where the page from the chat sends people,
 * opens it) and Unlink.
 */
export function SurfacePrefRow() {
  const { t } = useTranslation();
  const toast = useToast();
  const links = useSurfaceLinks();
  const remove = useRemoveSurfaceLink();
  const { org } = useOrg();
  const assistant = useAssistantName(org.id) ?? t("rightHand.labelCapitalized");
  const [open, setOpen] = useOpenParam("link");
  const [pinOpen, setPinOpen] = useOpenParam("pin");
  const [unlinking, setUnlinking] = useState<SurfaceLink | null>(null);
  const row = surfaceRowOf(links.data);
  if (row.kind === "hidden") return null;
  const { surface } = row;
  const sender =
    row.kind === "active"
      ? [row.link.display && formatPhone(row.link.display), row.link.profileName].filter(Boolean)
      : [];

  return (
    <>
      <PrefRow
        id="notice-surface"
        lead={<SurfaceMark name={surface} />}
        label={surface}
        hint={
          row.kind === "active"
            ? t("surface.row.hint", { assistant, surface })
            : row.kind === "none"
              ? t("surface.row.none", { assistant })
              : undefined
        }
        status={
          row.kind === "pending" ? (
            t("surface.row.pending")
          ) : sender.length > 0 ? (
            <span className="surface-sender__line">
              {sender.map((s, i) => (
                <span key={s}>
                  {i > 0 && " · "}
                  <bdi>{s}</bdi>
                </span>
              ))}
            </span>
          ) : undefined
        }
        onOpen={row.kind === "pending" ? () => setOpen(1) : undefined}
        control={
          row.kind === "active" ? (
            <Button size="sm" icon="block" onClick={() => setUnlinking(row.link)}>
              {t("surface.row.unlink")}
            </Button>
          ) : (
            <Button size="sm" icon="link" onClick={() => setOpen(1)}>
              {t("surface.row.link")}
            </Button>
          )
        }
      />
      {row.kind === "active" && (
        <PrefRow
          id="notice-surface-pin"
          icon="lock"
          label={t("surface.pin.row")}
          hint={t("surface.pin.text", { surface })}
          control={
            <Button size="sm" onClick={() => setPinOpen(1)}>
              {row.link.pinSet ? t("surface.pin.change") : t("surface.pin.set")}
            </Button>
          }
        />
      )}
      {row.kind === "active" && <SurfaceNudgeRows link={row.link} surface={surface} assistant={assistant} />}
      <SurfaceLinkDialog open={open !== null} onClose={() => setOpen(null)} />
      <SurfacePinDialog
        link={pinOpen !== null && row.kind === "active" ? row.link : null}
        surface={surface}
        onClose={() => setPinOpen(null)}
      />
      <Dialog
        open={unlinking !== null}
        onOpenChange={(o) => !o && !remove.isPending && setUnlinking(null)}
        title={t("surface.row.unlinkTitle", { surface })}
        description={t("surface.row.unlinkText", { assistant })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setUnlinking(null)} disabled={remove.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              unlinking &&
              remove.mutate(unlinking.id, {
                onSuccess: () => {
                  toast.show(t("surface.row.unlinked", { surface }));
                  setUnlinking(null);
                },
                onError: (e) => toast.show(errorText(t, e), "error"),
              })
            }
          >
            {t("surface.row.unlink")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/**
 * The unread nudge under a linked surface (ADR 0234): on or off, after how long, and the quiet hours, each saved at
 * once. When and whether one goes is the server's call.
 */
function SurfaceNudgeRows({ link, surface, assistant }: { link: SurfaceLink; surface: string; assistant: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const save = useSetSurfaceNudge();
  const { nudge } = link;
  const change = (input: Partial<SurfaceLink["nudge"]>) =>
    save.mutate({ linkId: link.id, ...input }, { onError: (e) => toast.show(errorText(t, e), "error") });
  const hours = DAY_HOURS.map((h) => ({ value: String(h), label: hourLabel(i18n.language, h) }));
  return (
    <>
      <PrefRow
        id="notice-surface-nudge"
        icon="bell"
        label={t("surface.nudge.title")}
        hint={t("surface.nudge.hint", { assistant, surface })}
        control={
          <Switch
            checked={nudge.on}
            onCheckedChange={(on) => change({ on })}
            disabled={save.isPending}
            aria-label={t("surface.nudge.title")}
          />
        }
      />
      {nudge.on && (
        <>
          <PrefRow
            id="notice-surface-nudge-after"
            icon="clock"
            label={t("surface.nudge.after")}
            control={
              <Select
                size="sm"
                value={String(nudge.afterHours)}
                onValueChange={(v) => change({ afterHours: Number(v) })}
                options={NUDGE_AFTER_HOURS.map((h) => ({
                  value: String(h),
                  label: t("surface.nudge.hours", { hours: h }),
                }))}
                disabled={save.isPending}
                aria-label={t("surface.nudge.after")}
              />
            }
          />
          <PrefRow
            id="notice-surface-nudge-quiet"
            icon="mute"
            label={t("surface.nudge.quiet")}
            hint={t("surface.nudge.quietHint")}
            actions={
              <>
                <Select
                  size="sm"
                  value={String(nudge.quietFrom)}
                  onValueChange={(v) => change({ quietFrom: Number(v) })}
                  options={hours}
                  disabled={save.isPending}
                  aria-label={t("surface.nudge.quietFrom")}
                />
                <Select
                  size="sm"
                  value={String(nudge.quietTo)}
                  onValueChange={(v) => change({ quietTo: Number(v) })}
                  options={hours}
                  disabled={save.isPending}
                  aria-label={t("surface.nudge.quietTo")}
                />
              </>
            }
          />
        </>
      )}
    </>
  );
}

/**
 * Linking the surface, in three steps like the desktop hand-over: a code to send from it (a QR of the surface's own
 * link with the code typed in), the wait for it to arrive, then the person checks the sender that sent it and
 * confirms. The code answers in the workspace these settings are in.
 */
export function SurfaceLinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { org } = useOrg();
  const links = useSurfaceLinks();
  const confirm = useConfirmSurfaceLink();
  const remove = useRemoveSurfaceLink();
  const [sent, setSent] = useState(false);
  const [linked, setLinked] = useState<SurfaceLink | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  // The active links when the dialog opened: one more, confirmed on another device, ends it as linked.
  const [before, setBefore] = useState<string[] | null>(null);
  const data = links.data;
  useEffect(() => {
    if (!open) {
      setSent(false);
      setLinked(null);
      setFailure(null);
      setBefore(null);
    } else if (data) setBefore((b) => b ?? data.links.filter((l) => l.status === "active").map((l) => l.id));
  }, [open, data]);

  useQuery({
    queryKey: keys.surfaceLinks,
    queryFn: () => api.surfaces.list(),
    enabled: open,
    refetchInterval: LINK_POLL_MS,
  });
  const row = surfaceRowOf(links.data);
  const surface = row.kind === "hidden" ? "" : row.surface;
  const pending = row.kind === "pending" ? row.link : null;
  const done = linked ?? (before && newlyLinked(links.data, before));
  const step = done ? "done" : failure ? "failed" : pending ? "confirm" : sent ? "wait" : "code";
  // The link answers in its own workspace, which may not be the one these settings are in (a code made elsewhere).
  const assistant = useAssistantName((done ?? pending)?.orgId ?? org.id);
  const named = assistant ?? t("rightHand.labelCapitalized");

  const code = useQuery({
    queryKey: ["surfaceLinkCode", org.id],
    queryFn: async () => {
      const minted = await api.surfaces.mintCode(org.id);
      return { ...minted, endsAt: codeDeadline(minted, Date.now()) };
    },
    enabled: open && (step === "code" || step === "wait"),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchInterval: (q) =>
      q.state.data && !q.state.error ? Math.max(1000, q.state.data.endsAt - RENEW_BEFORE_MS - Date.now()) : false,
    refetchOnWindowFocus: (q) =>
      q.state.data && !q.state.error && q.state.data.endsAt - RENEW_BEFORE_MS <= Date.now() ? "always" : false,
  });
  const now = useNow(open && code.isSuccess && 1000);
  const busy = confirm.isPending || remove.isPending;
  // A sender still waiting (one linked to someone else, or not the person's) would bring the confirm back: it is
  // canceled first, and the step stays until it is gone, out of the cache too, so its card never comes back meanwhile.
  const startAgain = () => {
    const fresh = () => {
      if (pending)
        qc.setQueryData<SurfaceLinks>(
          keys.surfaceLinks,
          (d) => d && { ...d, links: d.links.filter((l) => l.id !== pending.id) },
        );
      setFailure(null);
      setSent(false);
      void code.refetch();
    };
    if (!pending) return fresh();
    remove.mutate(pending.id, {
      onSuccess: fresh,
      onError: (e) => (errorCode(e) === "surface.link_gone" ? fresh() : setFailure(e)),
    });
  };

  const title =
    step === "done"
      ? t("surface.link.doneTitle", { surface })
      : step === "confirm"
        ? t("surface.link.confirmTitle", { surface })
        : t("surface.link.title", { assistant: named, surface });
  const steps = (
    <ol className="dv-steps">
      <Step state={step === "code" ? "current" : "done"} live={false} title={t("surface.link.stepScan")} />
      <Step
        state={step === "code" ? "waiting" : step === "wait" ? "current" : "done"}
        title={t("surface.link.stepSend")}
        text={step === "wait" ? t("surface.link.stepSendText") : undefined}
      />
      <Step state={step === "confirm" ? "current" : "waiting"} live={false} title={t("surface.link.stepConfirm")} />
    </ol>
  );
  const openUrl = code.data && isHttpsUrl(code.data.openUrl) ? code.data.openUrl : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={440}
    >
      {step === "done" ? (
        <>
          <DialogBody>
            <p className="surface-link__text">{t("surface.link.doneText", { assistant: named })}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>
              {t("surface.link.done")}
            </Button>
          </DialogFooter>
        </>
      ) : step === "failed" ? (
        <>
          <DialogBody>
            <Alert>{errorText(t, failure)}</Alert>
          </DialogBody>
          <DialogFooter>
            {NEW_CODE_FIXES.has(errorCode(failure) ?? "") ? (
              <Button variant="primary" loading={remove.isPending} disabled={remove.isPending} onClick={startAgain}>
                {t("surface.link.newCode")}
              </Button>
            ) : (
              <Button onClick={onClose}>{t("common.close")}</Button>
            )}
          </DialogFooter>
        </>
      ) : step === "confirm" && pending ? (
        <>
          <DialogBody className="surface-link">
            <div className="surface-sender">
              <span className="small muted">{t("surface.link.sentBy")}</span>
              {pending.display && (
                <bdi className="surface-sender__display" dir="auto">
                  {formatPhone(pending.display)}
                </bdi>
              )}
              {pending.profileName && (
                <bdi className="surface-sender__line" dir="auto">
                  {pending.profileName}
                </bdi>
              )}
              {pending.orgName && (
                <span className="small muted surface-sender__line">
                  {t("surface.link.workspace", { workspace: pending.orgName })}
                </span>
              )}
            </div>
            <p className="small surface-link__text">{t("surface.link.onlyYou")}</p>
            {steps}
            {assistant && (
              <p className="small muted surface-link__text">{t("surface.link.consent", { assistant, surface })}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" loading={remove.isPending} disabled={busy} onClick={startAgain}>
              {t("surface.link.notMe")}
            </Button>
            <Button
              variant="primary"
              loading={confirm.isPending}
              disabled={busy || !assistant}
              onClick={() => confirm.mutate(pending.id, { onSuccess: setLinked, onError: setFailure })}
            >
              {t("surface.link.confirm")}
            </Button>
          </DialogFooter>
        </>
      ) : code.isError ? (
        <DialogBody className="surface-link">
          <Alert>{errorText(t, code.error)}</Alert>
          {MINT_FINAL.has(errorCode(code.error) ?? "") ? (
            <Button onClick={onClose}>{t("common.close")}</Button>
          ) : (
            <Button loading={code.isFetching} disabled={code.isFetching} onClick={() => void code.refetch()}>
              {t("common.retry")}
            </Button>
          )}
        </DialogBody>
      ) : (
        <DialogBody className="surface-link">
          {step === "code" && (
            <div className="phone-code">
              <div className="phone-code__qr" data-loading={!openUrl || undefined}>
                {openUrl ? (
                  <QrCode text={openUrl} label={t("surface.link.qr", { surface })} />
                ) : (
                  <PixelSpinner size={24} label={t("surface.link.making")} />
                )}
              </div>
            </div>
          )}
          {code.data && (
            <p className="small muted surface-link__code">
              <span>{t("surface.link.code", { code: code.data.code })}</span>
              <span>
                {t("openOnPhone.validFor", {
                  time: formatTimeLeft(Math.min(CODE_TTL_MS, Math.max(0, code.data.endsAt - now))),
                })}
              </span>
            </p>
          )}
          {steps}
          {openUrl && (
            <Button asChild block>
              <a href={openUrl} target="_blank" rel="noreferrer" onClick={() => setSent(true)}>
                <Icon name="external" size={16} />
                {t("surface.link.open", { surface })}
              </a>
            </Button>
          )}
          {step === "wait" && (
            <Button variant="ghost" onClick={() => setSent(false)}>
              {t("surface.link.showCode")}
            </Button>
          )}
        </DialogBody>
      )}
    </Dialog>
  );
}

/** Choosing the PIN in the app (ADR 0226): the signed-in session is what lets it, so a link from the chat never can. */
function SurfacePinDialog({
  link,
  surface,
  onClose,
}: {
  link: SurfaceLink | null;
  surface: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSetSurfacePin();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  useEffect(() => {
    if (!link) {
      setPin("");
      setAgain("");
      save.reset();
    }
  }, [link, save.reset]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!link || save.isPending || !pinChosen(pin, again)) return;
    save.mutate(
      { linkId: link.id, pin },
      {
        onSuccess: () => {
          toast.show(t("surface.pinReset.done"));
          onClose();
        },
      },
    );
  };
  const error = pinMismatch(pin, again) ? t("surface.page.mismatch") : save.isError ? errorText(t, save.error) : null;
  return (
    <Dialog
      open={link !== null}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title={t("surface.pin.title", { surface })}
      description={t("surface.pin.text", { surface })}
      closeLabel={t("common.close")}
      width={440}
    >
      <form onSubmit={submit} noValidate>
        <DialogBody className="surface-link">
          <PinFields choosing autoFocus pin={pin} again={again} onPin={setPin} onAgain={setAgain} />
          {error && <Alert>{error}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={save.isPending}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!pinChosen(pin, again)}>
            {t("surface.pin.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
