import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createFileArtifact, getArtifact, openDm, postPersonMessage } from "../src";
import { imageSize, pictureSize } from "../src/image-size";
import { type Fixture, setup } from "./fixtures";

/** The first bytes of each format with its size in them (what `imageSize` reads), padded as a real file would be. */
const png = (w: number, h: number) => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const gif = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([...new TextEncoder().encode("GIF89a")]);
  new DataView(b.buffer).setUint16(6, w, true);
  new DataView(b.buffer).setUint16(8, h, true);
  return b;
};
/** A JPEG with an APP0 segment before its start-of-frame (baseline, SOF0). */
const jpeg = (w: number, h: number) => {
  const b = new Uint8Array(64);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  new DataView(b.buffer).setUint16(25, h);
  new DataView(b.buffer).setUint16(27, w);
  return b;
};
const webp = (chunk: "VP8 " | "VP8L" | "VP8X", w: number, h: number) => {
  const b = new Uint8Array(40);
  const text = new TextEncoder();
  b.set(text.encode("RIFF"), 0);
  b.set(text.encode("WEBP"), 8);
  b.set(text.encode(chunk), 12);
  const v = new DataView(b.buffer);
  if (chunk === "VP8 ") {
    v.setUint16(26, w, true);
    v.setUint16(28, h, true);
  } else if (chunk === "VP8L") {
    v.setUint32(21, ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), true);
  } else {
    v.setUint16(24, (w - 1) & 0xffff, true);
    b[26] = ((w - 1) >> 16) & 0xff;
    v.setUint16(27, (h - 1) & 0xffff, true);
    b[29] = ((h - 1) >> 16) & 0xff;
  }
  return b;
};

describe("imageSize: a picture's size from its header", () => {
  test("PNG, GIF, JPEG and the three WebP chunks", () => {
    expect(imageSize(png(1024, 1536))).toEqual({ width: 1024, height: 1536 });
    expect(imageSize(gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(imageSize(jpeg(1536, 1024))).toEqual({ width: 1536, height: 1024 });
    expect(imageSize(webp("VP8 ", 800, 600))).toEqual({ width: 800, height: 600 });
    expect(imageSize(webp("VP8L", 640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(webp("VP8X", 4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  test("anything else, a cut header or a size of zero: none", () => {
    expect(imageSize(new TextEncoder().encode("%PDF-1.7 hello"))).toBeNull();
    expect(imageSize(png(1024, 1024).slice(0, 20))).toBeNull();
    expect(imageSize(png(0, 1024))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });

  test("pictureSize: both or nothing", () => {
    expect(pictureSize({ width: 10, height: 20 })).toEqual({ width: 10, height: 20 });
    expect(pictureSize({ width: 10, height: null })).toEqual({});
    expect(pictureSize({})).toEqual({});
  });
});

describe("a stored picture keeps its size", () => {
  let f: Fixture;
  afterEach(async () => {
    await f?.close();
  });

  test("its file's content says it, and so does its card on the message that carries it", async () => {
    f = await setup();
    const person = { type: "person" as const, userId: f.owner.id };
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const file = await createFileArtifact(f.artifactDeps, person, f.org.id, {
      title: "farol.png",
      name: "farol.png",
      bytes: png(1024, 1536),
      contentType: "image/png",
      channelId: dm.id,
    });
    expect(file.content).toMatchObject({ kind: "file", width: 1024, height: 1536 });
    expect((await getArtifact(f.artifactDeps, person, f.org.id, file.id)).content).toMatchObject({
      width: 1024,
      height: 1536,
    });
    // Not a picture: no size.
    const notes = await createFileArtifact(f.artifactDeps, person, f.org.id, {
      title: "notas.txt",
      name: "notas.txt",
      bytes: new TextEncoder().encode("oi"),
      contentType: "text/plain",
      channelId: dm.id,
    });
    expect(notes.content).not.toHaveProperty("width");

    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "olha",
      attachments: [file.id, notes.id],
    });
    const sent = (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).find(
      (m) => m.body === "olha",
    );
    expect(sent?.meta?.artifacts).toEqual([
      expect.objectContaining({
        id: file.id,
        version: 1,
        title: "farol.png",
        contentType: "image/png",
        width: 1024,
        height: 1536,
      }),
      expect.objectContaining({ id: notes.id, version: 1, title: "notas.txt", name: "notas.txt" }),
    ]);
  });
});
