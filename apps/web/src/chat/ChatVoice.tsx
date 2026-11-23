import type { Message, MessageVoice } from "@agenteschat/client";
import { VOICE_WAITING, voiceLocalUrl } from "@agenteschat/client";
import { voiceAudioGone, voiceAudioUrl, voiceExpired, voiceParts } from "@agenteschat/client/lib/voice";
import { Icon, VoicePlayer } from "@agenteschat/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { setVoiceSpeed, useVoiceSpeed } from "@/lib/voice-speed";

/**
 * A voice message (ADR 0100): the recording's player, with its words alone (the text typed beside it shows above it,
 * as the message's text). Its words stay closed until opened there; one still on its way
 * plays from this device. An expired one says so, by its date or by the server's 410.
 */
export function ChatVoice({ message, voice }: { message: Message; voice: MessageVoice }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const url = message.local ? voiceLocalUrl(message.clientId) : voiceAudioUrl(org.id, voice.clipId);
  const speed = useVoiceSpeed();
  const isGone = useCallback(() => (url ? voiceAudioGone(url) : Promise.resolve(false)), [url]);
  if (!url) return null;
  return (
    <VoicePlayer
      src={url}
      peaks={voice.peaks}
      durationMs={voice.durationMs}
      expired={voiceExpired(voice)}
      isGone={message.local ? undefined : isGone}
      words={voiceParts(message).words}
      speed={speed}
      onSpeed={setVoiceSpeed}
      note={
        message.meta?.[VOICE_WAITING] === true ? (
          <>
            <Icon name="clock" size={14} /> {t("voice.waiting")}
          </>
        ) : undefined
      }
      labels={{
        play: t("voice.play"),
        pause: t("voice.pausePlay"),
        seek: t("voice.seek"),
        speed: (speed) => t("voice.speedAt", { speed }),
        expired: t("voice.expired"),
        showText: t("voice.showText"),
        hideText: t("voice.hideText"),
        cantPlay: t("voice.cantPlay"),
        retry: t("common.retry"),
      }}
    />
  );
}
