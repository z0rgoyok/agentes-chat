import { describe, expect, test } from "bun:test";
import { scrubLogLine, urlOrigin } from "../src/error-scrub";

describe("scrubLogLine", () => {
  test("masks emails, addresses and keys", () => {
    const line = scrubLogLine(
      "from someone@example.com at 203.0.113.7 and 2001:db8::1 with sk-test-0000000000000000000000000000fake",
    );
    expect(line).not.toContain("someone@example.com");
    expect(line).not.toContain("203.0.113.7");
    expect(line).not.toContain("2001:db8::1");
    expect(line).not.toContain("sk-test-0000000000000000000000000000fake");
  });

  test("keeps a URL's origin only", () => {
    expect(scrubLogLine("GET https://chat.example.com/org/abc/wiki/secret-page?token=x failed")).toBe(
      "GET https://chat.example.com/… failed",
    );
    expect(scrubLogLine("open http://localhost:3000")).toBe("open http://localhost:3000");
  });

  test("a URL whose host is an IP, has credentials or is a local name keeps no path, password or name", () => {
    expect(scrubLogLine("GET http://192.168.1.5:3000/org/x/wiki/secret-page?token=abc")).toBe("GET http://[ip]:3000/…");
    expect(scrubLogLine("fetch https://user:hunter2@example.com/path failed")).toBe(
      "fetch https://example.com/… failed",
    );
    expect(scrubLogLine("postgres://agentes:pw@10.0.0.2:5432/agentes")).toBe("postgres://[ip]:5432/…");
    expect(scrubLogLine("GET http://[2001:db8::1]:8080/private/path")).not.toContain("private");
    expect(scrubLogLine("listening on http://someones-laptop.local:3000/")).toBe("listening on http://[host]:3000");
    expect(scrubLogLine("open http://studio-box.local:3000/private", [["studio-box", "computer"]])).toBe(
      "open http://[computer]/…",
    );
  });

  test("home folders become ~", () => {
    expect(scrubLogLine("C:\\Users\\someone\\.agentes-runner\\logs\\runner.log")).toBe(
      "~\\.agentes-runner\\logs\\runner.log",
    );
    expect(scrubLogLine("/Users/someone/.agentes-runner/config.json")).toBe("~/.agentes-runner/config.json");
    expect(scrubLogLine("/home/someone/x")).toBe("~/x");
  });

  test("a URL's credentials go whole, cookies are masked, a Windows account name with spaces goes whole", () => {
    expect(scrubLogLine("connect postgres://admin:p!ss@db.example.com:5432/agentes failed")).toBe(
      "connect postgres://db.example.com:5432/… failed",
    );
    expect(scrubLogLine("Set-Cookie: sid=s%3Afake123.sig; Path=/")).toBe("Set-Cookie: ***");
    expect(scrubLogLine("C:\\Users\\Some One\\.agentes-runner\\runner.log")).toBe("~\\.agentes-runner\\runner.log");
  });

  test("known values become their labels", () => {
    expect(scrubLogLine("Machine Studio Box connected", [["Studio Box", "computer"]])).toBe(
      "Machine [computer] connected",
    );
  });

  test("cuts long lines and is stable", () => {
    expect(scrubLogLine("x".repeat(5000)).length).toBeLessThanOrEqual(1000);
    const once = scrubLogLine("https://chat.example.com/a/b someone@example.com /Users/someone/x", [
      ["chat.example.com", "server"],
    ]);
    expect(scrubLogLine(once, [["chat.example.com", "server"]])).toBe(once);
  });

  test("urlOrigin", () => {
    expect(urlOrigin("https://example.com/a?b")).toBe("https://example.com");
    expect(urlOrigin("not a url")).toBeNull();
  });
});
