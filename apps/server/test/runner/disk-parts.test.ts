import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_WORKER_HOMES } from "@agenteschat/adapters/command-policy";
import { diskPartPaths, findRepos, keepDiskParts, keptDiskParts, measureDiskParts } from "../../runner/disk-parts";

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "disk-parts-")));

describe("disk parts", () => {
  test("narrower paths come before the folders holding them, so du counts each byte for its own kind", () => {
    const home = `${AGENT_WORKER_HOMES}/0a1b2c3d`;
    const repo = "/srv/agentes/ada-0a1b2c3d/site";
    const paths = diskPartPaths({ workspace: "/srv/agentes", homes: [home], repos: [repo] });
    const at = (p: string) => paths.findIndex(([, q]) => q === p);
    expect(paths[at(repo)]?.[0]).toBe("projects");
    expect(at(repo)).toBeLessThan(at("/srv/agentes"));
    expect(paths[at(`${home}/.cache`)]?.[0]).toBe("caches");
    expect(at(`${home}/.bun/install/cache`)).toBeLessThan(at(`${home}/.bun`));
    expect(paths[at(`${home}/.local`)]?.[0]).toBe("apps");
    expect(at(`${home}/.local`)).toBeLessThan(at(AGENT_WORKER_HOMES));
    expect(at("/var/cache/agentes-git")).toBeLessThan(at("/var/cache"));
    expect(at("/var/cache")).toBeLessThan(at("/var"));
    expect(at("/usr/local")).toBeLessThan(at("/usr"));
    expect(paths[at("/usr")]?.[0]).toBe("system");
  });

  test("checkouts are found a few folders deep, never inside node_modules, a hidden folder or another checkout", () => {
    const root = tmp();
    for (const dir of [
      "ada/site/.git",
      "ada/site/vendor/lib/.git",
      "ada/work/api/.git",
      "ada/node_modules/pkg/.git",
      "ada/.cache/x/.git",
      "bob/a/b/c/deep/.git",
    ]) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }
    expect(findRepos([root]).sort()).toEqual([path.join(root, "ada/site"), path.join(root, "ada/work/api")]);
  });

  test("du's totals add up by kind in GB; paths it never printed and lines of other paths count nothing", async () => {
    const workspace = tmp();
    const repo = path.join(workspace, "ada", "site");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    let asked: string[] = [];
    const parts = await measureDiskParts({ workspace, homes: [], repos: [repo, path.join(workspace, "gone")] }, (p) => {
      asked = p;
      return Promise.resolve(`${3 * 2 ** 20}\t${repo}\n${2 ** 20 / 2}\t${workspace}\n99\t/elsewhere\ngarbage\n`);
    });
    expect(asked.indexOf(repo)).toBeGreaterThanOrEqual(0);
    expect(asked.indexOf(repo)).toBeLessThan(asked.indexOf(workspace));
    expect(asked).not.toContain(path.join(workspace, "gone"));
    expect(parts).toMatchObject({ projects: 3, agents: 0.5 });
    expect(await measureDiskParts({ workspace, homes: [], repos: [] }, () => Promise.resolve(null))).toBeNull();
    expect(await measureDiskParts({ workspace: path.join(workspace, "nope"), homes: [], repos: [] })).toBeNull();
  });

  test("a measure kept in the runner's home stands until it is older than asked", () => {
    const home = tmp();
    const parts = { projects: 1, apps: 2, agents: 3, caches: 4, system: 5 };
    expect(keptDiskParts(home, 1000)).toBeNull();
    keepDiskParts(home, parts, 10_000);
    expect(keptDiskParts(home, 1000, 10_500)).toEqual(parts);
    expect(keptDiskParts(home, 1000, 11_000)).toBeNull();
  });
});
