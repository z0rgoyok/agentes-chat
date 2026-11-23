import { expect, test } from "bun:test";
import { appsUrls } from "../src/apps/urls";
import { connectCommands } from "../src/device-links";
import { withoutTrailingSlashes } from "../src/url-text";

test("an address loses the slashes it ends with, read once however long a run of them inside it", () => {
  expect(withoutTrailingSlashes("https://a.example//")).toBe("https://a.example");
  expect(withoutTrailingSlashes("https://a.example//x")).toBe("https://a.example//x");
  expect(withoutTrailingSlashes("///")).toBe("");
  expect(withoutTrailingSlashes("")).toBe("");
  expect(connectCommands("https://a.example/", "ABCD-EFGH").unix).toBe("curl -fsSL https://a.example/i/ABCD-EFGH | sh");
  expect(appsUrls("https://a.example//").resource).toBe("https://a.example/mcp");
  const started = performance.now();
  const run = `https://a.example${"/".repeat(200_000)}x`;
  expect(withoutTrailingSlashes(run)).toBe(run);
  expect(connectCommands(`${run}/`, "C").windows).toBe(`irm ${run}/i/C/ps | iex`);
  expect(appsUrls(`${run}//`).issuer).toBe(run);
  expect(performance.now() - started).toBeLessThan(1000);
});
