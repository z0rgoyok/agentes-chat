import { describe, expect, test } from "bun:test";
import {
  foldText,
  KEY_SHAPES,
  maskKeyShapes,
  normalizeUrl,
  outboundUrlProblem,
  replaceShapes,
  SIGNED_SHAPES,
  TextPrints,
  urlsIn,
} from "../src/outbound-url";

const prints = (...texts: string[]) => {
  const p = new TextPrints(1 << 20);
  for (const t of texts) p.add(t);
  return p;
};
const code = (url: string, opts?: Parameters<typeof outboundUrlProblem>[1]) =>
  outboundUrlProblem(url, opts)?.code ?? null;

describe("outboundUrlProblem", () => {
  test("a plain docs address passes", () => {
    expect(code("https://docs.example.dev/api/issues?state=open", { privateText: prints("anything") })).toBeNull();
  });

  test("an address that appeared as is passes, even with a long token", () => {
    const url = `https://files.example.com/share/${"a".repeat(300)}?token=${"x".repeat(700)}`;
    const seen = new Set(urlsIn(`here: ${url}.`));
    expect(code(url, { seen: (u) => seen.has(u) })).toBeNull();
    expect(code(url)).toBe("outbound.long");
  });

  test("a 600-character query is too long", () => {
    expect(code(`https://collect.example.net/v?d=${"q".repeat(600)}`)).toBe("outbound.long");
  });

  test("a path segment over 200 characters is too long", () => {
    expect(code(`https://collect.example.net/${"z".repeat(201)}`)).toBe("outbound.long");
  });

  test("a key in an address is refused", () => {
    expect(code(`https://collect.example.net/v?d=sk-ant-${"k".repeat(30)}`)).toBe("outbound.credential");
    expect(code(`https://collect.example.net/v?d=${encodeURIComponent(`ghp_${"A".repeat(36)}`)}`)).toBe(
      "outbound.credential",
    );
    // GitHub's stateless App token (`ghs_<app id>_<JWT>`).
    const app = `ghs_123_eyJhbGciOiJSUzI1NiJ9.${"e".repeat(40)}.${"s-ig_".repeat(8)}`;
    expect(code(`https://collect.example.net/v?d=${app}`)).toBe("outbound.credential");
  });

  test("a presigned address with an AWS key id passes without private text, not with it", () => {
    const url =
      "https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=abc";
    expect(code(url)).toBeNull();
    expect(code(url, { privateText: prints() })).toBe("outbound.credential");
  });

  test("private text copied into the query is refused; a short value is not", () => {
    const mail = prints("Your reset code is 448812. This link expires in 10 minutes, do not share it with anyone.");
    const leak = `https://x.io/v?c=${encodeURIComponent("448812 This link expires in 10 minutes")}`;
    expect(code(leak, { privateText: mail })).toBe("outbound.private_text");
    expect(code("https://x.io/v?c=448812", { privateText: mail })).toBeNull();
    // Case and whitespace don't hide it; `+` reads as a space.
    expect(code("https://x.io/v#THIS+LINK+expires+in+10++MINUTES", { privateText: mail })).toBe(
      "outbound.private_text",
    );
  });

  test("fingerprints catch every 24 characters in a row the text scan caught, wherever they sit", () => {
    // The check before fingerprints: some 24-character run of the folded query appears in a folded text.
    const scanned = (query: string, text: string) => {
      const [q, t] = [foldText(query), foldText(text)];
      for (let i = 0; i + 24 <= q.length; i++) if (t.includes(q.slice(i, i + 24))) return true;
      return false;
    };
    const words = "the of plant northern review safety code reset never share minutes 448812 board".split(" ");
    const pick = (n: number) =>
      Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join(" ");
    for (let round = 0; round < 300; round++) {
      const text = pick(60);
      const start = Math.floor(Math.random() * (text.length - 24));
      const query = `${pick(3)} ${text.slice(start, start + 24 + Math.floor(Math.random() * 10))} ${pick(3)}`;
      expect(scanned(query, text)).toBe(true);
      expect(prints(text).copiedIn(query)).toBe(true);
    }
    expect(prints("abcdefghijklmnopqrstuvwxyz0123").copiedIn("abcdefghijklmnopqrstuvw")).toBe(false);
  });

  test("past its bound a run keeps every read checked: the first text is still caught, the bytes stay within", () => {
    const p = new TextPrints(16 * 1024);
    p.add("Your reset code is 448812. Use it within 10 minutes and never share it.");
    const letters = "abcdefghijklmnopqrstuvwxyz ";
    for (let i = 0; i < 20; i++) {
      p.add(Array.from({ length: 10_000 }, () => letters[Math.floor(Math.random() * letters.length)]).join(""));
    }
    expect(p.bytes).toBeLessThanOrEqual(16 * 1024);
    expect(p.copiedIn("448812. Use it within 10 minutes")).toBe(true);
  });

  test("urlsIn drops an address's trailing punctuation, however long the run, and keeps a run inside it", () => {
    const run = "!".repeat(200_000);
    expect(urlsIn(`see https://example.com/a${run}b${run} and https://example.com/c?).`)).toEqual([
      `https://example.com/a${run}b`,
      "https://example.com/c",
    ]);
  });

  // Each took seconds when every `eyJ` after a `-` in a long run read the run to its end.
  test("a long run of JWT starts is read in time, and a key or a JWT in it is still masked", () => {
    const run = "eyJ-".repeat(40_000);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const privateText = prints("anything");
    const started = performance.now();
    expect(maskKeyShapes(run)).toBe(run);
    expect(maskKeyShapes(`${run}AKIAIOSFODNN7EXAMPLE-${run}`)).toBe(`${run}[REDACTED]-${run}`);
    expect(maskKeyShapes(`${run} ${jwt}`)).toBe(`${run} [REDACTED]`);
    // A JWT the run runs into is masked from the run's first start, as before.
    expect(maskKeyShapes(`${run}${jwt}`)).toBe("[REDACTED]");
    expect(code(`https://collect.example.net/v?d=${run}`, { privateText })).toBe("outbound.long");
    expect(code(`https://collect.example.net/v?d=${run}AKIAIOSFODNN7EXAMPLE`, { privateText })).toBe(
      "outbound.credential",
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("replaceShapes replaces what String.replace does, on random texts", () => {
    const both = new RegExp(`${KEY_SHAPES.source}|${SIGNED_SHAPES.source}`, "g");
    const by = (found: string) => `<${found}>`;
    // A Slack key that holds `-eyJ` and ends at `_` inside a run doesn't hide a JWT later in that run.
    const slack = "xoxb-1234567890-eyJab_c-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    expect(replaceShapes(slack, both, by)).toBe(slack.replace(both, by));
    const words = ["eyJ", "-eyJ", "-", "_", ".", "a", "aaaaaaaaaa", "AKIA", "ABCDEFGHIJKLMNOP", "xoxb-", "sk-", " "];
    for (let round = 0; round < 2000; round++) {
      const n = Math.floor(Math.random() * 40);
      const text = Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join("");
      for (const shapes of [SIGNED_SHAPES, both])
        expect(replaceShapes(text, shapes, by)).toBe(text.replace(shapes, by));
    }
  });

  test("normalizeUrl: https, lowercase host, no fragment, no trailing slash", () => {
    expect(normalizeUrl("http://Example.COM/a/?b=1#frag")).toBe("https://example.com/a/?b=1");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("ftp://example.com")).toBeNull();
  });

  test("normalizeUrl drops the trailing slashes in time, however long a run of them inside the address", () => {
    // Each took seconds when every `/` of the run inside read it to its end.
    const run = "/".repeat(100_000);
    const started = performance.now();
    expect(normalizeUrl(`https://example.com/a${run}b${run}`)).toBe(`https://example.com/a${run}b`);
    expect(urlsIn(`see https://example.com/a${run}b/ and`)).toEqual([`https://example.com/a${run}b`]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
