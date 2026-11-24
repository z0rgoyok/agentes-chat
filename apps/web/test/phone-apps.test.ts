import { expect, test } from "bun:test";
import { phoneStores } from "@/lib/phone-apps";

test("Google Play is offered on every server", () => {
  expect(phoneStores(false).map((s) => s.id)).toEqual(["googlePlay"]);
});

test("the iPhone beta is offered only on agentes.chat's own servers, first", () => {
  const stores = phoneStores(true);
  expect(stores.map((s) => s.id)).toEqual(["testFlight", "googlePlay"]);
  expect(stores[0]?.href).toStartWith("https://testflight.apple.com/join/");
});
