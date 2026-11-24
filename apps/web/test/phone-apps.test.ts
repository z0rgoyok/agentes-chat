import { expect, test } from "bun:test";
import { phoneStores } from "@/lib/phone-apps";

test("download links offer only the managed Android release on this server", () => {
  expect(phoneStores()).toEqual([{ id: "androidApk", href: "/downloads/tich-rooms.apk", mark: "android" }]);
});
