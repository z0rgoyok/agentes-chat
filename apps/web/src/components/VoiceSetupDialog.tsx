import {
  type OrgSettings,
  useAskAdmins,
  useInstallSpeechLocal,
  useMe,
  useSettings,
  useSpeechKey,
  useSpeechLocal,
} from "@agenteschat/client";
import type { VoiceSetupCard } from "@agenteschat/client/lib/action-cards";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatBytes } from "@agenteschat/client/lib/files";
import { voiceSetupAsk } from "@agenteschat/client/lib/voice";
import { Button, Dialog, DialogBody, DialogFooter, EventPillAction } from "@agenteschat/ui";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { LocalSpeechChoice, SpeechProviderPicker } from "@/components/VoiceSettings";
import { inlineWords } from "@/lib/markdown";
import { voiceSetupSeen } from "@/lib/storage";
import { useToast } from "@/lib/toast";

type Answer = boolean | "tap";

/**
 * The first press of the microphone where voice doesn't become text yet (`speechState` other than `ready`): the
 * server's owner chooses what turns it into text, everyone else asks them or records anyway (the note goes as audio).
 * Once per person on this browser; later presses record at once. `ask` is the composer's `allowed`: it answers when
 * the person picks.
 */
export function useVoiceSetup(settings: OrgSettings | undefined) {
  const me = useMe().data?.user.id ?? null;
  // What was asked, kept while the dialog is up: the state changes under it once voice becomes text.
  const [asked, setAsked] = useState<NonNullable<ReturnType<typeof voiceSetupAsk>> | null>(null);
  const answer = useRef<((a: Answer) => void) | null>(null);
  const fresh = voiceSetupSeen.useFresh(me ?? "");
  const needed = voiceSetupAsk(settings, me, fresh);
  const ask = useCallback((): Promise<Answer> => {
    if (!needed) return Promise.resolve(true);
    setAsked(needed);
    return new Promise((resolve) => {
      answer.current = resolve;
    });
  }, [needed]);
  const close = (a: Answer, seen: boolean) => {
    setAsked(null);
    if (me && seen) voiceSetupSeen.mark(me);
    answer.current?.(a);
    answer.current = null;
  };
  const dialog = (
    <VoiceSetupDialog
      open={asked !== null}
      owner={asked?.owner ?? null}
      isOwner={asked?.isOwner ?? false}
      onRecord={() => close("tap", true)}
      onDone={() => close(false, true)}
      onClose={() => close(false, false)}
    />
  );
  return { ask, dialog };
}

export function VoiceSetupDialog({
  open,
  owner,
  isOwner,
  onRecord,
  onDone,
  onClose,
}: {
  open: boolean;
  owner: { userId: string; name: string } | null;
  isOwner: boolean;
  /** Record now: the note goes, with words once something turns voice into text. */
  onRecord: () => void;
  /** Answered without recording (asked the owner): later presses record at once. */
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const askOwner = useAskAdmins(org.id);
  const speech = useSpeechKey();
  const [ready, setReady] = useState(false);
  const view = isOwner ? speech.data : null;
  const local = useSpeechLocal(isOwner && open);
  if (isOwner) {
    return (
      <Dialog
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={t(ready ? "voice.setup.readyTitle" : "voice.setup.ownerTitle")}
        description={t(ready ? "voice.setup.readyText" : "voice.setup.ownerText")}
        closeLabel={t("common.close")}
        width={600}
      >
        {!ready && view && (
          <DialogBody>
            {local.data && <LocalSpeechChoice view={local.data} onReady={() => setReady(true)} />}
            <SpeechProviderPicker view={view} onSaved={() => setReady(true)} />
          </DialogBody>
        )}
        <DialogFooter>
          {ready ? (
            <Button variant="primary" icon="mic" onClick={onRecord}>
              {t("voice.setup.record")}
            </Button>
          ) : (
            <Button onClick={onRecord}>{t("voice.setup.recordAnyway")}</Button>
          )}
        </DialogFooter>
      </Dialog>
    );
  }
  const name = owner?.name ?? null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("voice.setup.memberTitle")}
      description={name ? t("voice.setup.memberText", { name }) : t("voice.setup.memberTextNoName")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        {name && (
          <Button
            loading={askOwner.isPending}
            onClick={() =>
              askOwner.mutate(
                { what: "voice" },
                {
                  onSuccess: () => {
                    toast.show(t("voice.setup.asked", { name }));
                    onDone();
                  },
                  onError: (e) => toast.show(errorText(t, e), "error"),
                },
              )
            }
          >
            {t("voice.setup.ask", { name })}
          </Button>
        )}
        <Button variant="primary" icon="mic" onClick={onRecord}>
          {t("voice.setup.recordAnyway")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The right hand's "Ligar mensagens de voz" (`offer_voice_setup`): for the server's owner one click downloads the
 * speech model to the server's computer when it fits there, else opens the setup's dialog; anyone else asks the owner.
 * Done from live data: once voice becomes text here it says so.
 */
export function VoiceSetupCardView({ card }: { card: VoiceSetupCard }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const me = useMe().data?.user.id ?? null;
  const settings = useSettings(org.id).data;
  const owner = settings?.speechOwner ?? null;
  const isOwner = owner !== null && owner.userId === me;
  const local = useSpeechLocal(isOwner);
  const install = useInstallSpeechLocal();
  const ask = useAskAdmins(org.id);
  const [dialog, setDialog] = useState(false);
  if (settings?.speechState === "ready") {
    return (
      <RequestDone done label={t("voice.offer.title")}>
        {t("voice.offer.on")}
      </RequestDone>
    );
  }
  const fits = local.data?.fit === "fits" && local.data.status.state === "off";
  const installing = settings?.speechState === "installing";
  // The owner's button waits for what fits here, so "Choose how" never flashes before "Download".
  const action =
    installing || (isOwner && local.isPending) ? undefined : isOwner ? (
      fits ? (
        <EventPillAction
          primary
          disabled={install.isPending}
          onClick={() => install.mutate(undefined, { onError: (e) => toast.show(errorText(t, e), "error") })}
        >
          {t("voice.offer.download", { size: formatBytes(i18n.language, local.data?.sizeBytes ?? 0) })}
        </EventPillAction>
      ) : (
        <EventPillAction primary onClick={() => setDialog(true)}>
          {t("voice.offer.choose")}
        </EventPillAction>
      )
    ) : owner ? (
      <EventPillAction
        primary
        disabled={ask.isPending}
        onClick={() =>
          ask.mutate(
            { what: "voice" },
            {
              onSuccess: () => toast.show(t("voice.setup.asked", { name: owner.name })),
              onError: (e) => toast.show(errorText(t, e), "error"),
            },
          )
        }
      >
        {t("voice.setup.ask", { name: owner.name })}
      </EventPillAction>
    ) : undefined;
  return (
    <>
      <RequestOpen
        mine={false}
        icon="mic"
        label={t("voice.offer.title")}
        action={action}
        below={
          <>
            {card.why && <p>{inlineWords(card.why)}</p>}
            {installing && <p>{t("voice.local.downloading")}</p>}
          </>
        }
      >
        {t(isOwner ? "voice.offer.askOwner" : "voice.offer.askMember")}
      </RequestOpen>
      {dialog && (
        <VoiceSetupDialog
          open
          owner={owner}
          isOwner
          onRecord={() => setDialog(false)}
          onDone={() => setDialog(false)}
          onClose={() => setDialog(false)}
        />
      )}
    </>
  );
}
