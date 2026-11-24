import { expect, test } from "bun:test";
import { redactCredentials, scrubSignIns } from "../src/tool-detail";

const NOTE = "[removed]";
const fake = (prefix: string, n = 24) => `${prefix}${"x".repeat(n)}`;

test("the right hand's reply: keys, tokens and a sign-in file's values become the note, the rest stays", () => {
  const app = `ghs_123_eyJhbGciOiJSUzI1NiJ9.${"e".repeat(40)}.${"s-ig_".repeat(8)}`;
  const cases: [string, string][] = [
    [`here: ${fake("sk-ant-oat01-")} ok`, `here: ${NOTE} ok`],
    [`refresh ${fake("sk-ant-ort01-")}`, `refresh ${NOTE}`],
    [fake("sk-proj-"), NOTE],
    [fake("sk-"), NOTE],
    [`cursor ${fake("key_", 64)}`, `cursor ${NOTE}`],
    [fake("crsr_", 40), NOTE],
    [`token ${fake("rt_", 30)}.`, `token ${NOTE}.`],
    // Codex's own `auth.json` refresh token today.
    [`token ${fake("rt.", 40)}.${"y".repeat(20)}`, `token ${NOTE}`],
    [`jwt eyJ${"F".repeat(12)}.${"F".repeat(12)}.${"F".repeat(12)}`, `jwt ${NOTE}`],
    // GitHub's stateless App token (`ghs_<app id>_<JWT>`): all of it, dots and dashes included.
    [`fetch ${app} failed`, `fetch ${NOTE} failed`],
    ['{"refresh_token": "abcdefgh12345678"}', `{"refresh_token": ${NOTE}}`],
    ['{"accessToken":"abcdefgh12345678","x":1}', `{"accessToken":${NOTE},"x":1}`],
    ["id_token=abcdefgh12345678", `id_token=${NOTE}`],
    ["OPENAI_API_KEY: abcdefgh12345678", `OPENAI_API_KEY: ${NOTE}`],
    ["-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", NOTE],
  ];
  for (const [text, want] of cases) {
    const out = scrubSignIns(text, NOTE);
    expect(out.text).toBe(want);
    expect(out.found).toBeGreaterThan(0);
  }
});

test("plain words about sign-ins stay as they are", () => {
  for (const text of [
    "Sign in with your Claude plan in Settings › AI accounts.",
    "Paste the API key in the card's dialog, never here.",
    "Your refresh token lives on the computer, I can't see it.",
    "skills and keys are set up per agent",
  ]) {
    expect(scrubSignIns(text, NOTE)).toEqual({ text, found: 0 });
  }
});

test("scrubbed twice it reads the same, and a value that only starts like the note is still scrubbed", () => {
  const note = "[removed: it looked like a sign-in or a key]";
  const once = scrubSignIns('{"refresh_token": "abcdefgh12345678"} and id_token=abcdefgh12345678', note);
  expect(once.found).toBe(2);
  expect(scrubSignIns(once.text, note)).toEqual({ text: once.text, found: 0 });
  // The note in front of a real value hides nothing.
  for (const [text, mark] of [
    ["api_key=••••abcdefgh12345678", "••••"],
    ["refresh_token=[removed]abcdefgh12345678", NOTE],
  ] as const) {
    const out = scrubSignIns(text, mark);
    expect(out.text).not.toContain("abcdefgh12345678");
    expect(out.found).toBe(1);
  }
});

test("an option with a long name and an address with a long scheme are read in linear time", () => {
  // One word of 200,000 characters, each `token` of it a place where the option's name could hold a secret's.
  const option = `--${"token".repeat(40_000)}`;
  // And one where each letter could start an address's scheme.
  const scheme = "a.".repeat(100_000);
  const started = performance.now();
  expect(redactCredentials(option)).toBe(option);
  expect(redactCredentials(`${option} fake-value`)).toBe(`${option} ***`);
  expect(redactCredentials(`${option}s 4096`)).toBe(`${option}s 4096`);
  expect(redactCredentials(scheme)).toBe(scheme);
  expect(redactCredentials(`${scheme}b://ana:fake-value@db.example.com/x`)).toBe(`${scheme}b://***@db.example.com/x`);
  // And a list of arguments where no option's value ends: each opens with a quote written as no other is.
  let list = "";
  for (let n = 1; list.length < 200_000; n++) list += `"--token",${"\\".repeat(n)}"x `;
  expect(redactCredentials(list)).not.toBe(list);
  // And addresses that each open a password and never end one, and headers that never close their quote.
  const addresses = "a://u:x".repeat(30_000);
  expect(redactCredentials(addresses)).toBe(addresses);
  expect(redactCredentials(`"cookie:${" x".repeat(100_000)}`)).toBe(`"cookie:${" x".repeat(100_000)}`);
  expect(performance.now() - started).toBeLessThan(250);
});

test("common credential shapes are masked: cloud keys, JWTs, passwords in addresses, private keys, headers", () => {
  const masked = (text: string) => redactCredentials(text);
  // Key shapes, all made up.
  for (const key of [
    "ASIAFAKEFAKEFAKEFAKE",
    `AIza${"F".repeat(35)}`,
    `ya29.${"fake".repeat(6)}`,
    `GOCSPX-${"fake".repeat(6)}`,
    `sk_live_${"FAKE".repeat(6)}`,
    `rk_test_${"FAKE".repeat(6)}`,
    `whsec_${"FAKE".repeat(8)}`,
    `glpat-${"fake".repeat(6)}`,
    `npm_${"fake".repeat(9)}`,
    `hf_${"fake".repeat(9)}`,
    `dop_v1_${"f".repeat(64)}`,
    `SG.${"f".repeat(22)}.${"f".repeat(43)}`,
    `eyJhbGciOiJub25lIn0.eyJ${"e".repeat(20)}.`,
  ]) {
    expect(masked(`use ${key} here`)).toBe("use •••• here");
  }
  expect(masked("aws_secret_access_key = fakeFAKEfake/FAKEfakeFAKE+fakeFAKEfake0")).toBe("aws_secret_access_key = ***");
  expect(masked('{"SecretAccessKey": "fakeFAKEfake/FAKEfake"}')).not.toContain("fakeFAKEfake");
  expect(masked("AccountName=demo;AccountKey=ZmFrZS1rZXk=;EndpointSuffix=example.com")).not.toContain("ZmFrZS1rZXk");
  expect(masked("Server=db.example.com;Uid=app;Pwd=fake-pass;")).toBe("Server=db.example.com;Uid=app;Pwd=***");

  // A password with `/` or `@` in an address, which the first `@` alone would leave half there.
  expect(masked("postgres://app:fa/ke@db.example.com:5432/x")).toBe("postgres://***@db.example.com:5432/x");
  expect(masked("mysql://app:fa@ke@db.example.com/x?to=ana@example.com")).toBe(
    "mysql://***@db.example.com/x?to=ana@example.com",
  );

  // A private key's block: PGP's, one whose first line is wrapped, and the end of one that started in an earlier text.
  // Its lines are put together here, so the repository's secret scan reads no key in this file.
  const line = (edge: string, words: string) => `${"-".repeat(5)}${edge} ${words}${"-".repeat(5)}`;
  const body = "ZmFrZQ==\nZmFrZQ==";
  expect(
    masked(`${line("BEGIN", "PGP PRIVATE KEY BLOCK")}\n${body}\n${line("END", "PGP PRIVATE KEY BLOCK")}\nthanks`),
  ).toBe("••••\nthanks");
  expect(masked(`here:\n${line("BEGIN", "RSA PRIVATE\nKEY")}\n${body}`)).toBe("here:\n••••");
  expect(masked(`${body}\n${line("END", "RSA PRIVATE KEY")}\nthanks`)).toBe("••••\nthanks");
  expect(masked(`a ${line("BEGIN", "EC PRIVATE KEY")}\n${body}\n${line("END", "EC PRIVATE KEY")} b`)).toBe("a •••• b");

  // An Authorization or Cookie header's value whole after its scheme's word, whatever the scheme.
  expect(masked('Authorization: Digest username="ana", response="0fake0fake0fake0"\nAccept: */*')).toBe(
    "Authorization: Digest ***\nAccept: */*",
  );
  expect(masked("authorization: AWS4-HMAC-SHA256 Credential=x/2026/s3, Signature=0fake0fake")).toBe(
    "authorization: AWS4-HMAC-SHA256 ***",
  );
  expect(masked("http https://example.com 'Authorization: fake-bare-token' x=1")).toBe(
    "http https://example.com 'Authorization: ***' x=1",
  );
  expect(masked('{"line":"Cookie: sid=fake-session","ok":true}')).toBe('{"line":"Cookie: ***","ok":true}');
  expect(masked("Authorization: Bearer fake-token-0000")).toBe("Authorization: Bearer ***");
  expect(masked("the authorization header was missing")).toBe("the authorization header was missing");
});
