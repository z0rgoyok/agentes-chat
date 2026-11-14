import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Me, OrgSummary } from "@agenteschat/client";
import { workspacesBeyond } from "../src/features/me/logic";
import { orderedServers, unreadElsewhere, workspacesOf } from "../src/features/me/workspaces-logic";
import { newWorkspaceMade, offersNewWorkspaceHere } from "../src/lib/new-workspace";
import { readPushData } from "../src/lib/push-payload";
import {
  accountsFrom,
  claimedPrefixes,
  cookieTo,
  perServerName,
  placeFor,
  placeFrom,
  prefixesFrom,
  pushPlace,
  serverAfter,
  serverListFrom,
  serverOf,
  serverSlug,
  serverToReturn,
  sharedAccounts,
  twinPlace,
  withoutServer,
  withPrefix,
  withServer,
} from "../src/lib/server-choice";

// Workspaces across servers (ADR 0154).
const cloud = "https://app.agentes.chat";
const box = "https://agentes.exemplo.com.br";
const lab = "https://lab.tail1234.ts.net";

describe("a session per server", () => {
  test("the server used before keeps the old prefix, so whoever was signed in stays", () => {
    expect(prefixesFrom(null, box, "agenteschat")).toEqual({ [box]: "agenteschat" });
    const kept = prefixesFrom(JSON.stringify({ [box]: "agenteschat" }), cloud, "agenteschat");
    expect(kept).toEqual({ [box]: "agenteschat" });
    // Unreadable or odd values: as on the first launch, or dropped.
    expect(prefixesFrom("{", box, "agenteschat")).toEqual({ [box]: "agenteschat" });
    expect(prefixesFrom(JSON.stringify({ [box]: "a b", [cloud]: 3 }), box, "agenteschat")).toEqual({});
  });

  test("a server signed in to before prefixes were saved keeps the one made from its address, and its files", () => {
    const kept = claimedPrefixes({ [box]: "agenteschat" }, [box, cloud], "agenteschat");
    expect(kept).toEqual({ [box]: "agenteschat", [cloud]: `agenteschat_${serverSlug(cloud)}` });
    expect(kept[cloud]).toMatch(/^[A-Za-z0-9._-]+$/);
    // Saved once, it is read back as it is.
    const read = prefixesFrom(JSON.stringify(kept), lab, "agenteschat");
    expect(claimedPrefixes(read, [box, cloud], "agenteschat")).toEqual(kept);
    expect(perServerName("outbox", kept[box] ?? "", "agenteschat")).toBe("outbox");
    expect(perServerName("outbox", kept[cloud] ?? "", "agenteschat")).toBe(`outbox.${serverSlug(cloud)}`);
    expect(perServerName("outbox", "agenteschat_0b1c2d3e-random", "agenteschat")).toBe("outbox.0b1c2d3e-random");
  });

  test("a prefix has one owner: an address made to match another server's never gets that server's session", () => {
    // Two addresses whose 32-bit slugs are equal.
    const mine = "https://s1pi94at.example";
    const lookalike = "https://sm1ezng.example";
    expect(serverSlug(lookalike)).toBe(serverSlug(mine));

    // Only a server signed in to keeps a prefix made from its address: one added later has none and gets a random one.
    const kept = claimedPrefixes({ [box]: "agenteschat" }, [mine], "agenteschat");
    expect(kept[mine]).toBe(`agenteschat_${serverSlug(mine)}`);
    expect(kept[lookalike]).toBeUndefined();
    // Both signed in to already: the first keeps it, the other starts over.
    expect(claimedPrefixes({}, [mine, lookalike], "agenteschat")).toEqual({ [mine]: kept[mine] ?? "" });
    expect(claimedPrefixes(kept, [lookalike, mine], "agenteschat")).toEqual(kept);
    // Met for the first time, each gets a random prefix of its own, never the one made from its address.
    let n = 0;
    const id = () => `id-${++n}`;
    const first = withPrefix({ [box]: "agenteschat" }, mine, "agenteschat", id);
    const both = withPrefix(first, lookalike, "agenteschat", id);
    expect(both).toEqual({ [box]: "agenteschat", [mine]: "agenteschat_id-1", [lookalike]: "agenteschat_id-2" });
    expect(Object.values(both)).not.toContain(`agenteschat_${serverSlug(mine)}`);
    // A server that has one keeps it.
    expect(withPrefix(both, mine, "agenteschat", id)).toEqual(both);
    expect(withPrefix(kept, lookalike, "agenteschat", id)[lookalike]).toBe("agenteschat_id-3");
    // Stored with two owners: the second is dropped.
    const stored = JSON.stringify({ [mine]: "p1", [lookalike]: "p1", [cloud]: "p2" });
    expect(prefixesFrom(stored, box, "agenteschat")).toEqual({ [mine]: "p1", [cloud]: "p2" });
  });

  test("a session's cookie goes to its own server's addresses only", () => {
    const cookie = "better-auth.session_token=made-up";
    expect(cookieTo(`${box}/api/app/me`, box, cookie)).toBe(cookie);
    expect(cookieTo(`${cloud}/api/app/me`, box, cookie)).toBe("");
    expect(cookieTo(`${box}.evil.example/api/app/me`, box, cookie)).toBe("");
    expect(cookieTo("https://box.example.com:8443/x", "https://box.example.com", cookie)).toBe("");
    expect(cookieTo("/api/app/me", box, cookie)).toBe("");
  });

  test("the servers signed in to: in the order added, each once, addresses only", () => {
    expect(serverListFrom(null)).toEqual([]);
    expect(serverListFrom(JSON.stringify([box, "not a server", box, 4, cloud]))).toEqual([box, cloud]);
    expect(serverListFrom("nope")).toEqual([]);
    expect(withServer([box], cloud)).toEqual([box, cloud]);
    expect(withServer([box, cloud], box)).toEqual([box, cloud]);
    expect(withoutServer([box, cloud], box)).toEqual([cloud]);
    // Signing out of one: the app goes to the next still signed in, or to sign-in with none left.
    expect(serverAfter([box, cloud], box)).toBe(cloud);
    expect(serverAfter([box], box)).toBeNull();
    expect(serverAfter([], box)).toBeNull();
    // The sign-in of a server just added goes back where the app came from, still signed in there.
    const team = "https://agentes.outra-equipe.com.br";
    expect(serverToReturn([cloud, box], team, box)).toBe(box);
    // Came from somewhere signed out since (or nowhere): any other signed in to.
    expect(serverToReturn([cloud], team, box)).toBe(cloud);
    expect(serverToReturn([cloud], team, null)).toBe(cloud);
    // A first sign-in has nowhere to go back.
    expect(serverToReturn([], team, box)).toBeNull();
    expect(serverToReturn([team], team, team)).toBeNull();
  });
});

describe("a push from another server", () => {
  test("names its server; it opens there, after the app moves, or nowhere for one it left", () => {
    expect(readPushData({ server: box, orgId: "o1" })).toEqual({ server: box, orgId: "o1" });
    expect(pushPlace(undefined, cloud, [cloud, box])).toEqual({ kind: "here" });
    expect(pushPlace(`${cloud}/`, cloud, [cloud, box])).toEqual({ kind: "here" });
    expect(pushPlace(box, cloud, [cloud, box])).toEqual({ kind: "switch", server: box });
    expect(pushPlace(lab, cloud, [cloud, box])).toEqual({ kind: "gone" });
    expect(pushPlace("not a server", cloud, [cloud])).toEqual({ kind: "here" });
  });
});

describe("Workspaces", () => {
  const org = (id: string, name: string): OrgSummary => ({ id, name, role: "member" }) as OrgSummary;

  test("every server signed in to, the current one listed even before its session is known", () => {
    expect(orderedServers([cloud, box], box)).toEqual([cloud, box]);
    expect(orderedServers([cloud], box)).toEqual([box, cloud]);
  });

  test("each server's workspaces with their unread counts, and the total outside the one open", () => {
    const here = workspacesOf({
      server: cloud,
      current: true,
      orgs: [org("a", "Acme"), org("n", "Estúdio Norte")],
      unread: [
        { orgId: "a", unread: 2 },
        { orgId: "n", unread: 3 },
      ],
      failed: false,
    });
    expect(here.host).toBe("agentes.chat");
    expect(here.orgs.map((o) => [o.id, o.unread])).toEqual([
      ["a", 2],
      ["n", 3],
    ]);
    const there = workspacesOf({ server: box, current: false, orgs: [org("o", "Oficina")], unread: [], failed: false });
    expect(there.host).toBe("agentes.exemplo.com.br");
    expect(there.orgs[0]?.unread).toBe(0);
    const withNews = workspacesOf({
      server: box,
      current: false,
      orgs: [org("o", "Oficina")],
      unread: [{ orgId: "o", unread: 1 }],
      failed: false,
    });
    // The open workspace's own unread isn't counted: Você says what waits elsewhere.
    expect(unreadElsewhere([here, withNews], "a")).toBe(4);
    // A server that didn't answer with nothing known keeps its group, saying so.
    const down = workspacesOf({ server: lab, current: false, orgs: [], unread: [], failed: true });
    expect(down.failed).toBe(true);
    expect(workspacesOf({ server: lab, current: false, orgs: [org("x", "X")], unread: [], failed: true }).failed).toBe(
      false,
    );
    // Known but silent this time: its workspaces stay, faded.
    expect(workspacesOf({ server: lab, current: false, orgs: [org("x", "X")], unread: [], failed: true }).quiet).toBe(
      true,
    );
    expect(down.quiet).toBe(false);
  });

  test("a new workspace asked for: over once another workspace is open than when the first run showed", () => {
    expect(newWorkspaceMade({ server: cloud }, "a")).toBe(false);
    expect(newWorkspaceMade({ server: cloud, from: "a" }, "a")).toBe(false);
    expect(newWorkspaceMade({ server: cloud, from: "a" }, "new")).toBe(true);
    expect(newWorkspaceMade({ server: cloud, from: null }, "new")).toBe(true);
  });

  test("Adicionar workspace on a server of one's own makes one there first, when the person may", () => {
    const me = (canCreateWorkspace?: boolean) => ({ user: { canCreateWorkspace } }) as Me;
    expect(offersNewWorkspaceHere(box, me(true))).toBe(true);
    // An older server doesn't say: it may.
    expect(offersNewWorkspaceHere(box, me())).toBe(true);
    expect(offersNewWorkspaceHere(box, me(false))).toBe(false);
    expect(offersNewWorkspaceHere(box, undefined)).toBe(false);
    // On agentes.chat its own row makes one there.
    expect(offersNewWorkspaceHere(cloud, me(true))).toBe(false);
    const sheet = readFileSync(join(import.meta.dir, "../src/features/me/WorkspacesPages.tsx"), "utf8");
    expect(sheet).toContain("{offersNewWorkspaceHere(server, me) ? (");
    expect(sheet).toContain('label={t("shell.newWorkspace")}');
    expect(sheet).toContain("askNewWorkspace(server);");
  });
});

describe("Você's workspace row", () => {
  const group = (current: boolean, ids: string[], failed = false) => ({
    current,
    failed,
    orgs: ids.map((id) => ({ id })),
  });

  test("how many more, and on how many other servers", () => {
    // Only the one open: nothing more to say.
    expect(workspacesBeyond([group(true, ["acme"])], "acme")).toEqual({ others: 0, servers: 0 });
    // More on this server only.
    expect(workspacesBeyond([group(true, ["acme", "loja"])], "acme")).toEqual({ others: 1, servers: 0 });
    // On another server: counted, and that server counted once.
    expect(workspacesBeyond([group(true, ["acme"]), group(false, ["nimbus", "sol"])], "acme")).toEqual({
      others: 2,
      servers: 1,
    });
    // A server that didn't answer still means there is more elsewhere.
    expect(workspacesBeyond([group(true, ["acme"]), group(false, [], true)], "acme")).toEqual({
      others: 0,
      servers: 1,
    });
  });
});

// Several accounts on one server (ADR 0183).
describe("accounts on one server", () => {
  const second = placeFor(cloud, "b2c3");
  const ana = { id: "u-ana", name: "Ana", email: "ana@example.com" };
  const bia = { id: "u-bia", name: "Bia", email: "bia@example.com" };

  test("a place is a server or one of its accounts, and only its server is an address", () => {
    expect(serverOf(cloud)).toBe(cloud);
    expect(serverOf(second)).toBe(cloud);
    expect(placeFrom(`${cloud}/#b2c3`)).toBe(second);
    expect(placeFrom(`${cloud}#not an id`)).toBeNull();
    expect(placeFrom("not a server#b2c3")).toBeNull();
    expect(serverListFrom(JSON.stringify([cloud, second, second, `${box}#`]))).toEqual([cloud, second]);
  });

  test("who is at each place is read back as saved, anything else dropped", () => {
    const saved = JSON.stringify({ [cloud]: ana, [second]: bia, "not a server": ana, [box]: { name: "No id" } });
    expect(accountsFrom(saved)).toEqual({ [cloud]: ana, [second]: bia });
    expect(accountsFrom("{")).toEqual({});
  });

  test("signing in to an added account as someone already there lands on theirs", () => {
    const accounts = { [cloud]: ana, [second]: bia };
    const third = placeFor(cloud, "c3d4");
    expect(twinPlace(third, "u-ana", [cloud, second], accounts)).toBe(cloud);
    expect(twinPlace(third, "u-new", [cloud, second], accounts)).toBeNull();
    // The same person on another server is another account.
    expect(twinPlace(box, "u-ana", [cloud, second], accounts)).toBeNull();
    expect(twinPlace(cloud, "u-ana", [cloud, second], accounts)).toBeNull();
  });

  test("the accounts of one server share the phone's push token there", () => {
    const accounts = { [cloud]: ana, [second]: bia, [box]: ana };
    expect(sharedAccounts(cloud, [cloud, second, box], accounts)).toEqual(["u-bia"]);
    expect(sharedAccounts(box, [cloud, second, box], accounts)).toEqual([]);
  });

  test("a push opens as the account it is for", () => {
    const who = (user: string | undefined) => ({ user, accounts: { [cloud]: ana, [second]: bia } });
    expect(pushPlace(cloud, cloud, [cloud, second], who("u-ana"))).toEqual({ kind: "here" });
    expect(pushPlace(cloud, cloud, [cloud, second], who("u-bia"))).toEqual({ kind: "switch", server: second });
    expect(pushPlace(cloud, second, [cloud, second], who("u-bia"))).toEqual({ kind: "here" });
    // Someone this phone signed out of since.
    expect(pushPlace(cloud, cloud, [cloud, second], who("u-gone"))).toEqual({ kind: "gone" });
    // An older server names nobody: on that server, as before.
    expect(pushPlace(cloud, second, [cloud, second], who(undefined))).toEqual({ kind: "here" });
    expect(pushPlace(box, second, [cloud, second, box], who(undefined))).toEqual({ kind: "switch", server: box });
  });
});
