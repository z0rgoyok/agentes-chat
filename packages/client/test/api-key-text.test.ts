import { describe, expect, test } from "bun:test";
import { looksLikeApiKey, withoutApiKeys } from "../src/lib/api-key-text";
import { isReservedKeyName, VAULT_KEY_NAME } from "../src/lib/vault";

// Made-up keys with the real shapes (random runs with digits), never real ones. The non-AI ones and Google's are
// joined at run time: secret scanners read a literal of those shapes as a real key.
const ANTHROPIC = "sk-ant-api03-Zq8xW2pL5mN7vR1tY4uI9oP3aS6dF0gH-jK2lZ8xC5vB1nM4qW7eR9tY2uI6oP0aS3dF";
const OPENAI = "sk-proj-4fG7hJ2kL9mN1pQ5rS8tU3vW6xY0zA2bC4dE7fG9hJ1kL3mN5pQ";
const LEGACY = "sk-9aB3cD5eF7gH1iJ3kL5mN7oP9qR1sT3uV5wX7yZ9aB1cD3eF";
const DEEPSEEK = "sk-0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
const GOOGLE = ["AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"].join("");
const OPENROUTER = ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-");
const GITHUB = ["ghp", "Fake0Fake1Fake2Fake3Fake4Fake5Fake6F"].join("_");
const GITHUB_PAT = ["github", "pat", "11FAKE0000fake1111fake2", "x".repeat(59)].join("_");
const SLACK = ["xoxb", "000000000000", "0000000000000", "FakeFakeFakeFake"].join("-");
const STRIPE = ["sk", "live", "Fake0fake1fake2fake3fake4"].join("_");
const STRIPE_RK = ["rk", "live", "Fake0fake1fake2fake3fake4"].join("_");
const AWS = ["AKIA", "FAKE0FAKE1FAKE2F"].join("");

describe("looksLikeApiKey", () => {
  test("finds the AI shapes people paste, with the Vault name each gets", () => {
    expect(looksLikeApiKey(`minha chave é ${ANTHROPIC}`)).toEqual({
      key: ANTHROPIC,
      ai: true,
      name: "MY_ANTHROPIC_API_KEY",
    });
    expect(looksLikeApiKey(OPENAI)).toEqual({ key: OPENAI, ai: true, name: "MY_OPENAI_API_KEY" });
    expect(looksLikeApiKey(`usa essa: ${LEGACY}.`)).toEqual({ key: LEGACY, ai: true, name: "MY_OPENAI_API_KEY" });
    expect(looksLikeApiKey(`deepseek ${DEEPSEEK}\nvaleu`)).toEqual({ key: DEEPSEEK, ai: true, name: "" });
    expect(looksLikeApiKey(`https://x.dev/?key=${GOOGLE}`)).toEqual({
      key: GOOGLE,
      ai: true,
      name: "MY_GEMINI_API_KEY",
    });
    expect(looksLikeApiKey(`\`${ANTHROPIC}\``)?.key).toBe(ANTHROPIC);
    expect(looksLikeApiKey(`tenho créditos na openrouter: ${OPENROUTER}`)).toEqual({
      key: OPENROUTER,
      ai: true,
      name: "OPENROUTER_API_KEY",
    });
  });

  test("finds other services' secrets as not an AI key", () => {
    expect(looksLikeApiKey(`o token: ${GITHUB}`)).toEqual({ key: GITHUB, ai: false, name: "GITHUB_TOKEN" });
    expect(looksLikeApiKey(GITHUB_PAT)).toEqual({ key: GITHUB_PAT, ai: false, name: "GITHUB_TOKEN" });
    expect(looksLikeApiKey(`slack ${SLACK}`)).toEqual({ key: SLACK, ai: false, name: "SLACK_TOKEN" });
    expect(looksLikeApiKey(STRIPE)).toEqual({ key: STRIPE, ai: false, name: "STRIPE_SECRET_KEY" });
    expect(looksLikeApiKey(STRIPE_RK)).toEqual({ key: STRIPE_RK, ai: false, name: "STRIPE_RESTRICTED_KEY" });
    expect(looksLikeApiKey(`aws ${AWS}`)).toEqual({ key: AWS, ai: false, name: "AWS_ACCESS_KEY_ID" });
  });

  test("every name it offers is one the Vault takes", () => {
    for (const key of [ANTHROPIC, OPENAI, LEGACY, GOOGLE, OPENROUTER, GITHUB, SLACK, STRIPE, STRIPE_RK, AWS]) {
      const name = looksLikeApiKey(key)?.name ?? "";
      expect(VAULT_KEY_NAME.test(name)).toBe(true);
      expect(isReservedKeyName(name)).toBe(false);
    }
  });

  test("normal text with sk- words, prefixes alone and hyphenated names is not a key", () => {
    for (const text of [
      "o sk-learn resolve isso",
      "as chaves de API do Claude começam com sk-ant-",
      "a branch sk-this-is-a-very-long-branch-name está pronta",
      "task-1234567890123456789012 no Linear",
      "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "AIza curto: AIzaSyA1b2C3",
      "bom dia, @ada",
      "tokens do GitHub começam com ghp_ ou github_pat_",
      "o canal xoxo-pessoal",
      "sk_live_ é a chave de produção do Stripe",
      "AKIAAAAAAAAAAAAAAAAA",
      "my_ghp_variable_name_is_long_enough_here",
    ]) {
      expect(looksLikeApiKey(text)).toBeNull();
    }
  });
});

describe("withoutApiKeys", () => {
  test("takes the keys out and keeps the rest of the message", () => {
    expect(withoutApiKeys(`minha chave é ${ANTHROPIC} e a outra ${GOOGLE}, conecta?`)).toBe(
      "minha chave é e a outra , conecta?",
    );
    expect(withoutApiKeys(`${OPENAI}\n@ada usa essa`)).toBe("@ada usa essa");
    expect(withoutApiKeys("o sk-learn fica")).toBe("o sk-learn fica");
    expect(withoutApiKeys(`@ada guarda ${GITHUB} e ${STRIPE}`)).toBe("@ada guarda e");
  });
});
