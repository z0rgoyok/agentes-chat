import { codeAndBoldParts } from "@agenteschat/client/lib/markdown";
import { Text as RNText, StyleSheet } from "react-native";
import { fonts, useTheme } from "./theme";

/**
 * Words with their `code` as the inline code pill and their **bold**, the rest as typed (the web's `codeAndBold`), to
 * go inside a `Text`: a sentence that names a command, a path or a setting, a task's title. Never a link or a mention.
 */
export function CodeWords({ text }: { text: string }) {
  const c = useTheme().colors;
  return codeAndBoldParts(text).map((part, k) =>
    part.mark ? (
      <RNText
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line, in order
        key={k}
        style={part.mark === "code" ? [styles.code, { backgroundColor: c.sunken, color: c.ink2 }] : styles.bold}
      >
        {part.text}
      </RNText>
    ) : (
      part.text
    ),
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: fonts.mono },
  bold: { fontWeight: "700" },
});
