import { isFeminineName } from "@agenteschat/i18n/format";

export { isFeminineName };

/**
 * `t` options for a sentence about an agent: its name and the i18next context its gender picks (`key_female` where a
 * language writes one, else `key`). `shown`: what the sentence writes for it when that is more than its name (its
 * name with a label beside it); the gender still comes from the name alone.
 */
export function agentGrammar(name: string, shown = name): { name: string; context: "female" | undefined } {
  return { name: shown, context: isFeminineName(name) ? "female" : undefined };
}
