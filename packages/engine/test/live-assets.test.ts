import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  copyAssetFrom,
  createChannel,
  createFileArtifact,
  deleteArtifact,
  getAsset,
  LIVE_ASSET_BYTES,
  listAssets,
  NotFoundError,
  purgeArtifactNow,
  putAsset,
  storageUsage,
  storedBytes,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { makeLiveFile, personActor } from "./live-fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(async () => {
  await f.close();
});

/** A 1×1 PNG. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
/** Another picture: a 2×1 GIF. */
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
  0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x02,
  0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const owner = () => personActor(f.owner.id);
const bytesOf = async (asset: Awaited<ReturnType<typeof getAsset>>) =>
  asset && "bytes" in asset
    ? asset.bytes
    : asset
      ? new Uint8Array(await new Response(asset.stream).arrayBuffer())
      : null;

describe("a live file's pictures", () => {
  test("stored with their type read from the bytes and their size; the same picture is kept once", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const png = await putAsset(f.artifactDeps, owner(), f.org.id, canvas.id, {
      bytes: PNG,
      contentType: "application/octet-stream",
      source: "upload",
    });
    expect(png).toMatchObject({ contentType: "image/png", size: PNG.byteLength, width: 1, height: 1 });
    const again = await putAsset(f.artifactDeps, owner(), f.org.id, canvas.id, {
      bytes: PNG,
      contentType: "image/png",
      source: "upload",
    });
    expect(again.id).toBe(png.id);
    const gif = await putAsset(f.artifactDeps, owner(), f.org.id, canvas.id, {
      bytes: GIF,
      contentType: "image/png",
      source: "generated",
    });
    expect(gif).toMatchObject({ contentType: "image/gif", width: 2, height: 1 });
    expect((await listAssets(f.artifactDeps, owner(), f.org.id, canvas.id)).map((a) => a.id).sort()).toEqual(
      [png.id, gif.id].sort(),
    );
    const served = await getAsset(f.artifactDeps, owner(), f.org.id, canvas.id, png.id);
    expect(served).toMatchObject({ contentType: "image/png", size: PNG.byteLength });
    expect(await bytesOf(served)).toEqual(PNG);
    // Who added it, in the audit log.
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "artifact.asset_added"));
    expect(audit).toHaveLength(2);
  });

  test("anything but a picture is refused, as is one too large", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const page = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    await expect(
      putAsset(f.artifactDeps, owner(), f.org.id, canvas.id, {
        bytes: page,
        contentType: "image/png",
        source: "upload",
      }),
    ).rejects.toMatchObject({ code: "live.asset_type" });
    // An SVG goes through the sanitizer (ADR 0196 §8): one it can't use is refused with its reason.
    const sizeless = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    );
    await expect(
      putAsset(f.artifactDeps, owner(), f.org.id, canvas.id, {
        bytes: sizeless,
        contentType: "image/png",
        source: "upload",
      }),
    ).rejects.toMatchObject({ code: "live.svg_invalid" });
    const big = new Uint8Array(LIVE_ASSET_BYTES + 1);
    big.set(PNG);
    await expect(
      putAsset(f.artifactDeps, owner(), f.org.id, canvas.id, {
        bytes: big,
        contentType: "image/png",
        source: "upload",
      }),
    ).rejects.toMatchObject({ code: "live.asset_too_large", params: { max: 25 } });
  });

  test("only who reads the file sees its pictures; only who may change it adds them", async () => {
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const hidden = await makeLiveFile(f, "canvas", { channelId: eng.id });
    const asset = await putAsset(f.artifactDeps, owner(), f.org.id, hidden.id, {
      bytes: PNG,
      contentType: "image/png",
      source: "upload",
    });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    expect(await getAsset(f.artifactDeps, personActor(ana.id), f.org.id, hidden.id, asset.id)).toBeNull();
    expect(await getAsset(f.artifactDeps, owner(), f.org.id, hidden.id, "not-an-id")).toBeNull();
    await expect(
      putAsset(f.artifactDeps, personActor(ana.id), f.org.id, hidden.id, {
        bytes: GIF,
        contentType: "image/gif",
        source: "upload",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // In the trash it reads, read-only: its pictures still show, none is added.
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, hidden.id);
    expect(await getAsset(f.artifactDeps, owner(), f.org.id, hidden.id, asset.id)).not.toBeNull();
    await expect(
      putAsset(f.artifactDeps, owner(), f.org.id, hidden.id, {
        bytes: GIF,
        contentType: "image/gif",
        source: "upload",
      }),
    ).rejects.toMatchObject({ code: "live.read_only" });
  });

  test("a picture is copied in from the Drive or from another live file, under the reader's own check", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const deck = await makeLiveFile(f, "slides", { title: "Pitch" });
    const upload = await createFileArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "Logo",
      name: "logo.png",
      bytes: PNG,
      contentType: "image/png",
    });
    const fromDrive = await copyAssetFrom(f.artifactDeps, owner(), f.org.id, canvas.id, { artifactId: upload.id });
    expect(fromDrive).toMatchObject({ contentType: "image/png", width: 1 });
    const fromCanvas = await copyAssetFrom(f.artifactDeps, owner(), f.org.id, deck.id, {
      fileId: canvas.id,
      assetId: fromDrive.id,
    });
    expect(fromCanvas.id).not.toBe(fromDrive.id);
    expect(await bytesOf(await getAsset(f.artifactDeps, owner(), f.org.id, deck.id, fromCanvas.id))).toEqual(PNG);
    // Who doesn't read where it comes from gets "not found".
    await expect(
      copyAssetFrom(f.artifactDeps, owner(), f.org.id, canvas.id, { artifactId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const secret = await makeLiveFile(f, "canvas", { channelId: eng.id });
    const theirs = await putAsset(f.artifactDeps, owner(), f.org.id, secret.id, {
      bytes: GIF,
      contentType: "image/gif",
      source: "upload",
    });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const mine = await makeLiveFile(f, "canvas", { actor: personActor(ana.id), title: "Mine" });
    await expect(
      copyAssetFrom(f.artifactDeps, personActor(ana.id), f.org.id, mine.id, { fileId: secret.id, assetId: theirs.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("pictures count in the workspace's storage and today's uploads, not in the trash, and go with the file", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const before = await storedBytes(f.db, f.org.id);
    const today = (await storageUsage(f.db, f.org.id)).uploadBytes24h;
    await putAsset(f.artifactDeps, owner(), f.org.id, canvas.id, {
      bytes: PNG,
      contentType: "image/png",
      source: "upload",
    });
    expect((await storedBytes(f.db, f.org.id)).platformBytes).toBe(before.platformBytes + PNG.byteLength);
    expect((await storageUsage(f.db, f.org.id)).uploadBytes24h).toBe(today + PNG.byteLength);
    const [docRow] = await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, canvas.id));
    expect(before.platformBytes).toBeGreaterThanOrEqual(docRow?.stateBytes ?? 1);
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, canvas.id);
    const trashed = await storedBytes(f.db, f.org.id);
    expect(trashed.platformBytes).toBeLessThan(before.platformBytes);
    const [kept] = await f.db.select().from(schema.liveAssets).where(eq(schema.liveAssets.artifactId, canvas.id));
    expect(f.platformBlobs.objects.has(kept?.blobKey ?? "")).toBe(true);
    // Deleted for good: its pictures' bytes and rows, its document and changes go; the row stays a tombstone.
    await purgeArtifactNow(f.artifactDeps, f.owner.id, f.org.id, canvas.id);
    expect(f.platformBlobs.objects.has(kept?.blobKey ?? "")).toBe(false);
    expect(await f.db.select().from(schema.liveAssets).where(eq(schema.liveAssets.artifactId, canvas.id))).toEqual([]);
    expect(await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, canvas.id))).toEqual([]);
    expect(await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, canvas.id))).toHaveLength(1);
  });
});
