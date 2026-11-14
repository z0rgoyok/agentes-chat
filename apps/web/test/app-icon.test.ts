import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { APP_ICONS } from "@agenteschat/client/lib/app-icons";
import {
  agentOf,
  appIcon,
  appIconPicture,
  faviconOf,
  followPickedAgent,
  parsePick,
  pickedAgent,
  picksAppIcon,
  setAppIcon,
} from "../src/lib/app-icon";
import { STORAGE_KEYS } from "../src/lib/storage";

describe("the app icon in a browser (ADR 0179)", () => {
  test("the shipped icon is the favicon browsers ask for; the others have their own", () => {
    expect(faviconOf("night")).toBe("/favicon.ico");
    expect(faviconOf("peekSky")).toBe("/app-icons/peekSky.ico");
    expect(APP_ICONS.map(appIconPicture)).toContain("/app-icons/moon.png");
    expect(picksAppIcon()).toBe(true);
  });

  test("a pick changes the tab's icon and stays in this browser", async () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />';
    const changes: string[] = [];
    const listen = () => changes.push(String(appIcon()));
    window.addEventListener("agentes:app-icon", listen);
    await setAppIcon("moon");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/app-icons/moon.ico");
    expect(localStorage.getItem(STORAGE_KEYS.appIcon)).toBe("moon");
    expect(appIcon()).toBe("moon");
    await setAppIcon("night");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/favicon.ico");
    expect(changes).toEqual(["moon", "night"]);
    window.removeEventListener("agentes:app-icon", listen);
  });

  test("an agent picked is kept with who it is and its look, and read back only when well formed", async () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />';
    const agent = { orgId: "o-1", id: "a_1", name: "Dev", look: { color: "violet" as const, eyes: "wide" as const } };
    await setAppIcon({ agent });
    expect(pickedAgent(appIcon())).toEqual(agent);
    expect(parsePick(localStorage.getItem(STORAGE_KEYS.appIcon))).toEqual({ agent });
    // Without a canvas to draw on (the test's DOM), the tab keeps the shipped icon.
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBeTruthy();
    expect(parsePick('{"agent":{"orgId":"../x","id":"a","name":"A","look":{}}}')).toBe("night");
    expect(parsePick("{not json")).toBe("night");
    expect(parsePick("moon")).toBe("moon");
    expect(agentOf({ orgId: "o", id: "a", name: " ", look: {} })).toBeNull();
    expect(agentOf({ orgId: "o", id: "a", name: "A", look: { color: "nope" } })?.look.color).toBeUndefined();
  });

  test("the picked agent follows its new name in its workspace, and nowhere else", async () => {
    await setAppIcon({ agent: { orgId: "o-1", id: "a_1", name: "Dev", look: { color: "violet" } } });
    followPickedAgent("o-2", [{ id: "a_1", name: "Other", appearance: { color: "violet" } }]);
    expect(pickedAgent(appIcon())?.name).toBe("Dev");
    followPickedAgent("o-1", [{ id: "a_2", name: "Ops" }]);
    expect(pickedAgent(appIcon())?.name).toBe("Dev");
    followPickedAgent("o-1", [{ id: "a_1", name: "Engenharia", appearance: { color: "violet" } }]);
    await Promise.resolve();
    expect(pickedAgent(appIcon())?.name).toBe("Engenharia");
    await setAppIcon("night");
  });
});
