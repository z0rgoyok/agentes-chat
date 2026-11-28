import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  confirmDeviceCode,
  defaultMachineName,
  friendlyMachineNames,
  getDeviceCode,
  hostnameLike,
  notify,
  reportedModel,
  startDeviceCode,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const tomas = { name: "Tomás Reis", locale: "pt-BR" as const };
const ana = { name: "Ana Souza", locale: "pt-BR" as const };
const sam = { name: "Sam Lee", locale: "en" as const };

describe("a computer's default name", () => {
  test("its model and its owner's first name, in the owner's language", () => {
    const mac = { hostname: "Tomass-MacBook-Pro.local", os: "darwin" };
    expect(defaultMachineName(mac, tomas)).toBe("MacBook Pro do Tomás");
    expect(defaultMachineName(mac, ana)).toBe("MacBook Pro da Ana");
    expect(defaultMachineName(mac, sam)).toBe("Sam's MacBook Pro");
    expect(defaultMachineName({ hostname: "MacBook-Air-de-Bia.local", os: "darwin" }, tomas)).toBe(
      "MacBook Air do Tomás",
    );
    expect(defaultMachineName({ hostname: "Mac-mini.local", os: "darwin" }, sam)).toBe("Sam's Mac mini");
    expect(defaultMachineName({ hostname: "estudio-pc.local", os: "darwin" }, sam)).toBe("Sam's Mac");
    expect(defaultMachineName({ hostname: "x", os: "darwin" }, { name: "Tomás", locale: "de" })).toBe("Mac von Tomás");
    expect(defaultMachineName({ hostname: "x", os: "darwin" }, { name: "Tomás", locale: "ja" })).toBe("TomásのMac");
  });

  test("the model the runner read wins, filler and virtual machines never show", () => {
    const pc = { hostname: "DESKTOP-AB12CD3", os: "windows" };
    expect(defaultMachineName(pc, tomas)).toBe("PC do Tomás");
    expect(defaultMachineName({ ...pc, model: "Dell Inspiron 15 3520" }, tomas)).toBe("Dell Inspiron 15 3520 do Tomás");
    expect(defaultMachineName({ ...pc, model: "System Product Name" }, sam)).toBe("Sam's PC");
    expect(defaultMachineName({ ...pc, model: "To Be Filled By O.E.M." }, sam)).toBe("Sam's PC");
    expect(reportedModel("Google Compute Engine")).toBe("");
    expect(reportedModel("Standard PC (Q35 + ICH9, 2009)")).toBe("");
    expect(reportedModel("20XW004KUS")).toBe("");
    expect(reportedModel("ThinkPad X1 Carbon Gen 9")).toBe("ThinkPad X1 Carbon Gen 9");
    expect(reportedModel("HP 250 G8")).toBe("HP 250 G8");
  });

  test("a Linux server is a Linux computer, never its instance id", () => {
    const vm = { hostname: "instance-20260101-0000", os: "linux", model: "Google Compute Engine" };
    expect(defaultMachineName(vm, tomas)).toBe("Computador Linux do Tomás");
    expect(defaultMachineName(vm, ana)).toBe("Computador Linux da Ana");
    expect(defaultMachineName(vm, sam)).toBe("Sam's Linux computer");
    expect(defaultMachineName({ hostname: "box", os: "other" }, sam)).toBe("Sam's computer");
    // Nobody to name it for: its model, else its host name without the network suffix.
    expect(defaultMachineName({ hostname: "Tomass-MacBook-Pro.local", os: "darwin" }, null)).toBe("MacBook Pro");
    expect(defaultMachineName(vm, null)).toBe("instance-20260101-0000");
  });

  test("a name made of the host name counts as nobody's choice", () => {
    expect(hostnameLike("Tomass-MacBook-Pro.local", "Tomass-MacBook-Pro.local")).toBe(true);
    expect(hostnameLike("Tomass-MacBook-Pro.local", "Tomass-MacBook-Pro-2.local")).toBe(true);
    expect(hostnameLike("Tomass-MacBook-Pro", "Tomass-MacBook-Pro.local")).toBe(true);
    expect(hostnameLike("MacBook-Air.local", "something-else")).toBe(true);
    expect(hostnameLike("", "box")).toBe(true);
    expect(hostnameLike("Trabalho", "box")).toBe(false);
    expect(hostnameLike("Build box", "box")).toBe(false);
    // Typed: another case, or a space no host name has.
    expect(hostnameLike("Studio", "studio")).toBe(false);
    expect(hostnameLike("Bia's PC", "Bia's PC")).toBe(false);
  });
});

async function pending(input: { name?: string; hostname: string; os: string; model?: string }) {
  return startDeviceCode(
    { db: f.db, publicUrl: "https://agentes.example" },
    {
      name: input.name ?? "",
      os: input.os,
      arch: "arm64",
      hostname: input.hostname,
      version: "1.0.0",
      ...(input.model ? { model: input.model } : {}),
    },
    { ip: `198.51.100.${Math.floor(Math.random() * 250)}` },
  );
}

test("connecting names the computer for who connects it, a chosen name stays, and two never share one", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "Rui Alves");
  await f.db.update(schema.users).set({ locale: "pt-BR" }).where(eq(schema.users.id, rui.id));
  const mac = {
    name: "Tomass-MacBook-Pro.local",
    hostname: "Tomass-MacBook-Pro.local",
    os: "darwin",
    model: "MacBook Pro",
  };

  const first = await pending(mac);
  // The confirm page offers it, so the field the person may change already reads well.
  expect((await getDeviceCode({ db: f.db }, first.userCode, rui.id)).name).toBe("MacBook Pro do Rui");
  expect((await confirmDeviceCode({ db: f.db }, rui.id, f.org.id, first.userCode, {})).name).toBe("MacBook Pro do Rui");

  // A second one, as the desktop app connects it (no name): told apart.
  const second = await pending(mac);
  expect((await confirmDeviceCode({ db: f.db }, rui.id, f.org.id, second.userCode, {})).name).toBe(
    "MacBook Pro do Rui 2",
  );

  const chosen = await pending({ ...mac, name: "Trabalho" });
  expect((await getDeviceCode({ db: f.db }, chosen.userCode, rui.id)).name).toBe("Trabalho");
  expect((await confirmDeviceCode({ db: f.db }, rui.id, f.org.id, chosen.userCode, {})).name).toBe("Trabalho");
});

test("computers still called by their host name take the friendly one once, with their inbox items", async () => {
  f = await setup();
  const ana = await addMember(f.db, f.org.id, "admin", "Ana Souza");
  await f.db.update(schema.users).set({ locale: "pt-BR" }).where(eq(schema.users.id, ana.id));
  const row = (name: string, hostname: string, os: string) => ({
    orgId: f.org.id,
    name,
    hostname,
    os,
    pairedByUserId: ana.id,
  });
  const [mac, vm, renamed, managed] = await f.db
    .insert(schema.machines)
    .values([
      row("Anas-MacBook-Air.local", "Anas-MacBook-Air.local", "darwin"),
      row("instance-20260101-0000", "instance-20260101-0000", "linux"),
      row("Estúdio", "Anas-Mac-Studio.local", "darwin"),
      { ...row("Computador da Acme", "", "linux"), kind: "managed" as const },
    ])
    .returning();
  if (!mac || !vm || !renamed || !managed) throw new Error("insert returned nothing");
  await notify(
    { db: f.db },
    {
      orgId: f.org.id,
      userIds: [ana.id],
      kind: "computer_disk_full",
      groupKey: `computer_disk_full:${vm.id}:1`,
      source: { machineId: vm.id, label: vm.name },
      latest: { title: vm.name, diskUse: 0.9 },
    },
  );

  const events: Record<string, unknown>[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push((e as { event?: Record<string, unknown> }).event ?? {}));
  expect(await friendlyMachineNames(f.db, f.pubsub)).toBe(2);
  // Open apps show the new name at once.
  expect(events).toContainEqual({ type: "machine.updated", machineId: vm.id, name: "Computador Linux da Ana" });
  const names = new Map(
    (await f.db.select({ id: schema.machines.id, name: schema.machines.name }).from(schema.machines)).map((m) => [
      m.id,
      m.name,
    ]),
  );
  expect(names.get(mac.id)).toBe("MacBook Air da Ana");
  expect(names.get(vm.id)).toBe("Computador Linux da Ana");
  expect(names.get(renamed.id)).toBe("Estúdio");
  expect(names.get(managed.id)).toBe("Computador da Acme");
  const [item] = await f.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.kind, "computer_disk_full"));
  expect(item?.source).toMatchObject({ label: "Computador Linux da Ana" });
  expect(item?.latest).toMatchObject({ title: "Computador Linux da Ana", diskUse: 0.9 });
  // Run again, nothing is left to rename.
  expect(await friendlyMachineNames(f.db)).toBe(0);
});
