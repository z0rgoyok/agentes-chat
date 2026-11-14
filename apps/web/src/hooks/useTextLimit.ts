import { overLimitText, tooLongText } from "@agenteschat/client/lib/message-length";
import type { TextLimit } from "@agenteschat/ui";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";

/**
 * A `Textarea`'s `limit` in the person's language. `fixKey`: for words that go to the agent as the person's message,
 * the message's size and limit, then this way out; without it the field's own text line.
 */
export function useTextLimit(max: number, fixKey?: ParseKeys): TextLimit {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  return {
    max,
    locale,
    over: (length) =>
      fixKey ? `${tooLongText(t, locale, length, max)} ${t(fixKey)}` : overLimitText(t, locale, length, max),
  };
}
