import { afterEach, expect, test } from "bun:test";
import { createMemoryBlobStore } from "@agenteschat/adapters";
import { type Database, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  baseUrlFor,
  ConflictError,
  deleteHost,
  enableCaches,
  HOSTS_MAX,
  hostLogoFile,
  hostLook,
  hostOrigin,
  normalizeHost,
  putHost,
  ValidationError,
} from "../src";

const OWN = new Set(["chat.example.com"]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
/** 8×2 RGBA: white ink in the middle, see-through around it. */
const WHITE_INK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAACCAYAAABllJ3tAAAAE0lEQVR42mNggIL/aIABHeBSAAAcXh/hYZBkvQAAAABJRU5ErkJggg==";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  enableCaches(false);
  await close?.();
  close = undefined;
});

async function world() {
  const t = await createTestDatabase();
  close = t.close;
  return { db: t.db as Database, blobs: createMemoryBlobStore() };
}

const refusal = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (e: unknown) => (e instanceof ValidationError || e instanceof ConflictError ? e.code : String(e)),
  );

test("normalizeHost: one comparable hostname, or null", () => {
  expect(normalizeHost("App.Northwind.Example")).toBe("app.northwind.example");
  expect(normalizeHost("app.northwind.example.")).toBe("app.northwind.example");
  for (const bad of [
    null,
    undefined,
    "",
    "localhost",
    "app.northwind.example:443",
    "app.northwind.example..",
    "https://app.northwind.example",
    "app.northwind.example/x",
    "user@app.northwind.example",
    "[::1]",
    "[2001:db8::1]:443",
    "2001:db8::1",
    "203.0.113.7",
    "-app.northwind.example",
    "app_northwind.example",
    " app.northwind.example",
    `${"a".repeat(64)}.example`,
    `${"a.".repeat(127)}example`,
  ]) {
    expect({ bad, host: normalizeHost(bad) }).toEqual({ bad, host: null });
  }
});

test("a registered host: its look, its origin and its links, by its own Host only", async () => {
  const { db, blobs } = await world();
  expect(await hostLook(db, "app.northwind.example")).toBeNull();
  await putHost({ db, blobs }, OWN, "App.Northwind.Example", { name: "Northwind Studio", accent: "#7C3AED" });
  expect(await hostLook(db, "APP.northwind.example.")).toMatchObject({
    host: "app.northwind.example",
    name: "Northwind Studio",
    accent: "#7c3aed",
    logo: null,
    poweredBy: true,
  });
  expect(await hostLook(db, "app.northwind.example:8443")).toBeNull();
  expect(await hostOrigin(db, new Headers({ host: "app.northwind.example" }))).toBe("https://app.northwind.example");
  expect(await hostOrigin(db, new Headers({ host: "chat.example.com" }))).toBeNull();
  // A forwarded host is never read.
  expect(
    await hostOrigin(db, new Headers({ host: "chat.example.com", "x-forwarded-host": "app.northwind.example" })),
  ).toBeNull();
  expect(await baseUrlFor(db, "https://chat.example.com/", "app.northwind.example")).toBe(
    "https://app.northwind.example",
  );
  expect(await baseUrlFor(db, "https://chat.example.com/", "chat.example.com")).toBe("https://chat.example.com");
  expect(await baseUrlFor(db, "https://chat.example.com", null)).toBe("https://chat.example.com");
});

test("the powered-by line: on for a new host, kept when left out, turned off and on", async () => {
  const { db, blobs } = await world();
  const deps = { db, blobs };
  const host = "app.northwind.example";
  expect((await putHost(deps, OWN, host, { name: "Northwind" })).poweredBy).toBe(true);
  expect((await putHost(deps, OWN, host, { name: "Northwind", poweredBy: false })).poweredBy).toBe(false);
  expect((await putHost(deps, OWN, host, { name: "Northwind", accent: "#0f766e" })).poweredBy).toBe(false);
  expect((await hostLook(db, host))?.poweredBy).toBe(false);
  expect((await putHost(deps, OWN, host, { name: "Northwind", poweredBy: true })).poweredBy).toBe(true);
});

test("refusals: not a hostname, the server's own, too many; and a logo's own", async () => {
  const { db, blobs } = await world();
  const put = (host: string, input: Parameters<typeof putHost>[3] = { name: "N" }) =>
    refusal(() => putHost({ db, blobs }, OWN, host, input));
  expect(await put("https://app.northwind.example")).toBe("host.invalid");
  expect(await put("app.northwind.example:443")).toBe("host.invalid");
  expect(await put("localhost")).toBe("host.invalid");
  expect(await put("Chat.Example.com.")).toBe("host.own");
  expect(
    await put("app.northwind.example", { name: "N", logo: { contentType: "image/png", base64: "PHN2Zy8+" } }),
  ).toBe("logo.type");
  expect(await db.select().from(schema.hosts)).toEqual([]);

  await db
    .insert(schema.hosts)
    .values(Array.from({ length: HOSTS_MAX }, (_, i) => ({ host: `h${i}.northwind.example`, name: `H${i}` })));
  expect(await put("one-more.northwind.example")).toBe("host.too_many");
  // Replacing one already there is no new host.
  expect(await put("h1.northwind.example", { name: "Renamed" })).toBeNull();
});

test("the logo: stored, replaced, kept when left out, deleted with the host", async () => {
  const { db, blobs } = await world();
  const deps = { db, blobs };
  const host = "app.northwind.example";
  await putHost(deps, OWN, host, { name: "Northwind Studio", logo: { contentType: "image/png", base64: PNG } });
  const first = (await hostLook(db, host))?.logo;
  expect(first).toMatch(/^host-logos\/app\.northwind\.example\/[0-9a-f]{8}-[0-9a-f]{16}\.png$/);
  expect((await hostLogoFile(deps, host))?.contentType).toBe("image/png");
  expect(await hostLogoFile(deps, "other.northwind.example")).toBeNull();

  await putHost(deps, OWN, host, { name: "Northwind" });
  expect((await hostLook(db, host))?.logo).toBe(first ?? "");

  // A light-ink logo's mark rides on the column, never on the stored file's key.
  await putHost(deps, OWN, host, { name: "Northwind", logo: { contentType: "image/png", base64: WHITE_INK_PNG } });
  const light = (await hostLook(db, host))?.logo ?? "";
  expect(light).toEndWith(".png#ink=light");
  expect(await blobs.list("host-logos/")).toEqual([light.replace("#ink=light", "")]);
  expect((await hostLogoFile(deps, host))?.contentType).toBe("image/png");

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9]).toString("base64");
  await putHost(deps, OWN, host, { name: "Northwind", logo: { contentType: "image/jpeg", base64: jpeg } });
  expect((await hostLook(db, host))?.logo).not.toBe(first ?? "");
  expect(await blobs.list("host-logos/")).toHaveLength(1);

  expect(await deleteHost(deps, host)).toBe(true);
  expect(await blobs.list("host-logos/")).toEqual([]);
  expect(await hostLook(db, host)).toBeNull();
  expect(await deleteHost(deps, host)).toBe(false);
});

test("the cache: kept per process, dropped at once on a write here", async () => {
  const { db, blobs } = await world();
  enableCaches(true);
  const host = "app.northwind.example";
  expect(await hostLook(db, host)).toBeNull();
  // Written behind the resolver's back: the cached answer stands.
  await db.insert(schema.hosts).values({ host, name: "Behind" });
  expect(await hostLook(db, host)).toBeNull();
  await putHost({ db, blobs }, OWN, host, { name: "Northwind Studio" });
  expect((await hostLook(db, host))?.name).toBe("Northwind Studio");
  await deleteHost({ db, blobs }, host);
  expect(await hostLook(db, host)).toBeNull();
});

/** A database whose `select … from … where` reads its rows, then answers only when released. */
function heldSelects(db: Database) {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let readNow = () => {};
  const read = new Promise<void>((r) => {
    readNow = r;
  });
  type Where = Parameters<ReturnType<ReturnType<Database["select"]>["from"]>["where"]>[0];
  const held = new Proxy(db, {
    get: (target, prop) =>
      prop === "select"
        ? (fields?: Parameters<Database["select"]>[0]) => ({
            from: (table: typeof schema.hosts) => ({
              where: async (where: Where) => {
                const rows = await (fields ? target.select(fields) : target.select()).from(table).where(where);
                readNow();
                await gate;
                return rows;
              },
            }),
          })
        : Reflect.get(target, prop),
  }) as Database;
  return { db: held, read, release };
}

/** A blob store whose writes, once written, answer only when released: one gate per write, in order. */
function heldPuts(blobs: ReturnType<typeof createMemoryBlobStore>) {
  const gates: (() => void)[] = [];
  const store: typeof blobs = {
    ...blobs,
    put: async (...args: Parameters<typeof blobs.put>) => {
      await blobs.put(...args);
      await new Promise<void>((r) => gates.push(r));
    },
  };
  return { store, release: (i: number) => gates[i]?.() };
}

test("the cache: a lookup that read before a delete here doesn't keep the deleted host", async () => {
  const { db, blobs } = await world();
  enableCaches(true);
  const host = "app.northwind.example";
  await putHost({ db, blobs }, OWN, host, { name: "Northwind Studio" });
  const held = heldSelects(db);
  const lookup = hostLook(held.db, host);
  await held.read;
  expect(await deleteHost({ db, blobs }, host)).toBe(true);
  held.release();
  expect((await lookup)?.name).toBe("Northwind Studio");
  expect(await hostLook(db, host)).toBeNull();
});

test("a replace and a delete never interleave: the delete stays deleted, no logo left dangling", async () => {
  const { db, blobs } = await world();
  const host = "app.northwind.example";
  await putHost({ db, blobs }, OWN, host, { name: "Northwind", logo: { contentType: "image/png", base64: PNG } });
  const held = heldSelects(db);
  // A rename that would read the row before the delete, if it read it outside the write's lock.
  const rename = putHost({ db: held.db, blobs }, OWN, host, { name: "Renamed" });
  await Promise.race([held.read, rename]);
  const deleted = deleteHost({ db, blobs }, host);
  held.release();
  await rename;
  expect(await deleted).toBe(true);
  expect(await db.select().from(schema.hosts)).toEqual([]);
  expect(await blobs.list("host-logos/")).toEqual([]);
});

test("two replaces with new logos: the last one's file stays, every other one is removed", async () => {
  const { db, blobs } = await world();
  const host = "app.northwind.example";
  await putHost({ db, blobs }, OWN, host, { name: "Northwind", logo: { contentType: "image/png", base64: PNG } });
  const slow = heldPuts(blobs);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9]).toString("base64");
  const a = putHost({ db, blobs: slow.store }, OWN, host, {
    name: "A",
    logo: { contentType: "image/jpeg", base64: jpeg },
  });
  const b = putHost({ db, blobs: slow.store }, OWN, host, {
    name: "B",
    logo: { contentType: "image/png", base64: PNG },
  });
  await Bun.sleep(10);
  slow.release(0);
  await a;
  slow.release(1);
  const last = await b;
  expect(await blobs.list("host-logos/")).toEqual([last.logo ?? ""]);
});

test("a replace that began before a delete: the logo it stored never outlives the host", async () => {
  const { db, blobs } = await world();
  const host = "app.northwind.example";
  await putHost({ db, blobs }, OWN, host, { name: "Northwind", logo: { contentType: "image/png", base64: PNG } });
  const slow = heldPuts(blobs);
  const replace = putHost({ db, blobs: slow.store }, OWN, host, {
    name: "Northwind",
    logo: { contentType: "image/png", base64: PNG },
  });
  await Bun.sleep(10);
  expect(await deleteHost({ db, blobs }, host)).toBe(true);
  slow.release(0);
  // The replace lands after the delete: a host of its own again, whose logo is there.
  const row = await replace;
  expect(await hostLogoFile({ db, blobs }, host)).not.toBeNull();
  expect(await blobs.list("host-logos/")).toEqual([row.logo ?? ""]);
});
