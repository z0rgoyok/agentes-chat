import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { desktopRenderer, desktopReportTags } from "@/lib/desktop";

const app = (bridge: object | undefined) => {
  (window as { __agentesDesktop?: object }).__agentesDesktop = bridge;
};

afterEach(() => app(undefined));

test("the renderer the app says it paints with; Linux apps that don't say painted on the CPU", () => {
  expect(desktopRenderer()).toBeNull();
  app({ platform: "linux", renderer: "gpu" });
  expect(desktopRenderer()).toBe("gpu");
  app({ platform: "linux", renderer: "cpu" });
  expect(desktopRenderer()).toBe("cpu");
  app({ platform: "linux" });
  expect(desktopRenderer()).toBe("cpu");
  app({ platform: "mac" });
  expect(desktopRenderer()).toBe("gpu");
  app({ platform: "windows", renderer: "something else" });
  expect(desktopRenderer()).toBe("gpu");
});

test("error reports carry how the app draws, from the app's own facts only", () => {
  expect(desktopReportTags()).toEqual({});
  app({ platform: "mac", renderer: "gpu", system: null });
  expect(desktopReportTags()).toEqual({ desktop_renderer: "gpu" });
  app({
    platform: "linux",
    renderer: "cpu",
    system: {
      distro: "Ubuntu 26.04 LTS",
      session: "wayland (GNOME)",
      webkit: "2.50.4",
      gpu: "",
      renderer: "cpu",
      bundle: "AppImage",
      odd: 3,
    },
  });
  expect(desktopReportTags()).toEqual({
    desktop_renderer: "cpu",
    desktop_distro: "Ubuntu 26.04 LTS",
    desktop_session: "wayland (GNOME)",
    desktop_webkit: "2.50.4",
    desktop_bundle: "AppImage",
  });
});

test("painted on the CPU, glass is solid and nothing blurs or loops", () => {
  const css = readFileSync(path.join(import.meta.dir, "../src/desktop.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  expect(rule('html[data-desktop-renderer="cpu"] [data-theme]')).toContain("--glass: var(--glass-solid)");
  const all = rule('html[data-desktop-renderer="cpu"] *::after');
  expect(all).toContain("backdrop-filter: none !important");
  expect(all).toContain("-webkit-backdrop-filter: none !important");
  expect(all).toContain("animation-iteration-count: 1 !important");
});
