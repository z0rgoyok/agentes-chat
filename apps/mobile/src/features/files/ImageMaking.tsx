import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { PixelOrbit } from "@/agent/PixelOrbit";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Text } from "@/ui";
import { useColors } from "../shared/hooks";

/** As wide as a lone picture gets in a message (`MessageFiles`). */
const MAX_SIDE = 300;

/**
 * Where a picture an agent is making will show, while it makes it (`makingImage`), as the web's `ImageMaking`: a lone
 * picture's square box with the picture forming out of the agent's sky (the `forming` dither, in its soft tones over
 * the conversation's background), the pixel orbit and "Criando a imagem…", until the reply takes its place with the
 * picture. Its image tool says nothing until it is done, so it shows no progress.
 */
export const ImageMaking = memo(function ImageMaking({ color }: { color: AgentColorName }) {
  const { t } = useTranslation();
  const c = useColors();
  const [width, setWidth] = useState(0);
  const side = Math.min(width || MAX_SIDE, MAX_SIDE);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={styles.wrap}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("files.imageMaking")}
        style={[styles.box, { width: side, height: side, backgroundColor: c.bg, borderColor: c.line2 }]}
      >
        <Dither kind="forming" tones={softTones(color, c.bg)} pixel={3} style={StyleSheet.absoluteFill} />
        <View style={styles.label} importantForAccessibility="no-hide-descendants">
          <PixelOrbit color={color} size={14} />
          <Text variant="caption" tone="muted">
            {t("files.imageMaking")}
          </Text>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch" },
  // As a lone picture's box (`MessageFiles` `shot`).
  box: { borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  label: { position: "absolute", left: 12, bottom: 10, flexDirection: "row", alignItems: "center", gap: 6 },
});
