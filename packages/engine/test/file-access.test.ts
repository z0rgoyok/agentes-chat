import { afterEach, describe, expect, test } from "bun:test";
import {
  type ArtifactActor,
  addChannelMember,
  createAgent,
  createArtifact,
  createChannel,
  createRole,
  type FileAccessInput,
  getArtifact,
  listArtifacts,
  liveFileAccess,
  NEW_AGENT_DEFAULTS,
  setFileAccess,
  setFileSharing,
  setMemberRoles,
  updateArtifact,
  withPersonFacts,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { makeLiveFile, personActor } from "./live-fixtures";

/**
 * Who sees and who edits a file (ADR 0202): people, roles and agents, each to view or edit, beside who reads it where
 * it lives and the whole workspace. Files from before keep their rule: whoever sees edits, an agent where it lives
 * edits.
 */

let f: Fixture;
afterEach(async () => {
  const open = f as Fixture | undefined;
  f = undefined as unknown as Fixture;
  await open?.close();
});

const OPEN: FileAccessInput = {
  place: "edit",
  workspace: "edit",
  users: [],
  roles: [],
  agents: "edit",
  agentRows: [],
};

/** Bia made a spreadsheet in the Drive itself; Caio and Duda are other members, the owner an administrator. */
async function world() {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const duda = await addMember(f.db, f.org.id, "member", "duda");
  const sheet = await makeLiveFile(f, "spreadsheet", { title: "Orçamento", actor: personActor(bia.id) });
  const mode = async (actor: ArtifactActor, id = sheet.id) =>
    (await liveFileAccess(f.artifactDeps, actor, f.org.id, id))?.mode ?? null;
  const agentHere: ArtifactActor = { type: "agent", agentId: f.agent.id, channelId: f.general.id };
  return { bia, caio, duda, sheet, mode, agentHere };
}

describe("who edits among people", () => {
  test("a file from before: whoever sees it edits, as always", async () => {
    const { caio, sheet, mode } = await world();
    expect(sheet.access).toMatchObject({ workspace: "edit", place: "edit", limited: false, agents: "edit" });
    expect(await mode(personActor(caio.id))).toBe("edit");
  });

  test("everyone views, the people and roles named edit; its maker and administrators always do", async () => {
    const { bia, caio, duda, sheet, mode } = await world();
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Finanças", permissions: [] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, duda.id, [finance.id]);
    const saved = await setFileAccess(f.artifactDeps, bia.id, f.org.id, sheet.id, {
      ...OPEN,
      workspace: "view",
      users: [{ id: caio.id, level: "edit" }],
      roles: [{ id: finance.id, level: "edit" }],
    });
    expect(saved.access).toMatchObject({
      workspace: "view",
      limited: true,
      users: [{ id: caio.id, level: "edit" }],
      roles: [{ id: finance.id, level: "edit" }],
    });
    const eva = await addMember(f.db, f.org.id, "member", "eva");
    expect(await mode(personActor(eva.id))).toBe("view");
    expect(await mode(personActor(caio.id))).toBe("edit");
    expect(await mode(personActor(duda.id))).toBe("edit");
    expect(await mode(personActor(bia.id))).toBe("edit");
    expect(await mode(personActor(f.owner.id))).toBe("edit");
    // The apps hear it as each person's own access.
    const [forEva] = await withPersonFacts(f.db, eva.id, f.org.id, [saved]);
    const [forCaio] = await withPersonFacts(f.db, caio.id, f.org.id, [saved]);
    expect([forEva?.myAccess, forCaio?.myAccess]).toEqual(["view", "edit"]);
  });

  test("only named people see it, some to view: who views reads, and can't change who sees it", async () => {
    const { bia, caio, duda, sheet, mode } = await world();
    await setFileAccess(f.artifactDeps, bia.id, f.org.id, sheet.id, {
      ...OPEN,
      workspace: "none",
      users: [
        { id: caio.id, level: "view" },
        { id: duda.id, level: "edit" },
      ],
    });
    const eva = await addMember(f.db, f.org.id, "member", "eva");
    expect(await mode(personActor(eva.id))).toBeNull();
    expect(await mode(personActor(caio.id))).toBe("view");
    expect(await mode(personActor(duda.id))).toBe("edit");
    // A viewer may not open it to more people; the maker may.
    await expect(setFileAccess(f.artifactDeps, caio.id, f.org.id, sheet.id, { ...OPEN })).rejects.toMatchObject({
      code: "artifact.sharing_forbidden",
    });
  });

  test("a person who only views a document can't save a version of it", async () => {
    const { bia, caio } = await world();
    const table = await createArtifact(f.artifactDeps, personActor(bia.id), f.org.id, {
      title: "Custos",
      content: { kind: "table", columns: ["Item"], rows: [["Café"]] },
    });
    await setFileAccess(f.artifactDeps, bia.id, f.org.id, table.id, { ...OPEN, workspace: "view" });
    await expect(
      updateArtifact(f.artifactDeps, personActor(caio.id), f.org.id, table.id, {
        content: { kind: "table", columns: ["Item"], rows: [["Chá"]] },
        baseVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "artifact.view_only" });
    const read = await getArtifact(f.artifactDeps, personActor(caio.id), f.org.id, table.id);
    expect(read.title).toBe("Custos");
  });

  test("a file in a conversation: its members only view, the people named edit", async () => {
    const { bia, caio, duda } = await world();
    const room = await createChannel(f.db, bia.id, f.org.id, { name: "orcamento", visibility: "private" });
    await addChannelMember(f.db, bia.id, f.org.id, room.id, { userId: caio.id });
    await addChannelMember(f.db, bia.id, f.org.id, room.id, { userId: duda.id });
    const deck = await makeLiveFile(f, "slides", { title: "Plano", actor: personActor(bia.id), channelId: room.id });
    await setFileAccess(f.artifactDeps, bia.id, f.org.id, deck.id, {
      ...OPEN,
      place: "view",
      workspace: "none",
      users: [{ id: duda.id, level: "edit" }],
    });
    const mode = async (userId: string) =>
      (await liveFileAccess(f.artifactDeps, personActor(userId), f.org.id, deck.id))?.mode ?? null;
    expect(await mode(caio.id)).toBe("view");
    expect(await mode(duda.id)).toBe("edit");
    expect(await mode(bia.id)).toBe("edit");
    // Nor through the sharing route installed phones still call.
    await expect(
      setFileSharing(f.artifactDeps, caio.id, f.org.id, deck.id, { mode: "everyone" }),
    ).rejects.toMatchObject({ code: "artifact.sharing_forbidden" });
  });
});

describe("agents", () => {
  test("a file from before: an agent where it lives edits, as always", async () => {
    const { sheet, mode, agentHere } = await world();
    expect(await mode(agentHere)).toBe("edit");
    expect(sheet.access.agents).toBe("edit");
  });

  test("no agent: not one opens it or finds it, but the one named", async () => {
    const { bia, sheet, mode, agentHere } = await world();
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
    const qaHere: ArtifactActor = { type: "agent", agentId: qa.id, channelId: f.general.id };
    await setFileAccess(f.artifactDeps, bia.id, f.org.id, sheet.id, {
      ...OPEN,
      agents: "none",
      agentRows: [{ id: qa.id, level: "edit" }],
    });
    expect(await mode(agentHere)).toBeNull();
    expect((await listArtifacts(f.db, agentHere, f.org.id)).map((a) => a.id)).not.toContain(sheet.id);
    expect(await mode(qaHere)).toBe("edit");
    expect((await listArtifacts(f.db, qaHere, f.org.id)).map((a) => a.id)).toContain(sheet.id);
  });

  test("an agent named on a file still never opens it where nobody asking sees it", async () => {
    const { bia, sheet } = await world();
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
    const qaHere: ArtifactActor = { type: "agent", agentId: qa.id, channelId: f.general.id };
    const mode = async () => (await liveFileAccess(f.artifactDeps, qaHere, f.org.id, sheet.id))?.mode ?? null;
    // Only Bia sees it: QA, named to edit, reaches it neither where it lives nor for someone who sees it.
    await setFileAccess(f.artifactDeps, bia.id, f.org.id, sheet.id, {
      ...OPEN,
      workspace: "none",
      agents: "none",
      agentRows: [{ id: qa.id, level: "edit" }],
    });
    expect(await mode()).toBeNull();
    expect((await listArtifacts(f.db, qaHere, f.org.id)).map((a) => a.id)).not.toContain(sheet.id);
    await expect(getArtifact(f.artifactDeps, qaHere, f.org.id, sheet.id)).rejects.toThrow();
    // Everyone sees it: QA edits it, the other agents nothing.
    await setFileAccess(f.artifactDeps, bia.id, f.org.id, sheet.id, {
      ...OPEN,
      workspace: "view",
      agents: "none",
      agentRows: [{ id: qa.id, level: "edit" }],
    });
    expect(await mode()).toBe("edit");
  });

  test("every agent views: agents read it, and are told how to change it", async () => {
    const { bia, sheet, mode, agentHere } = await world();
    const table = await createArtifact(f.artifactDeps, personActor(bia.id), f.org.id, {
      title: "Custos",
      content: { kind: "table", columns: ["Item"], rows: [["Café"]] },
    });
    for (const id of [sheet.id, table.id]) {
      await setFileAccess(f.artifactDeps, bia.id, f.org.id, id, { ...OPEN, agents: "view" });
    }
    expect(await mode(agentHere)).toBe("view");
    await expect(
      updateArtifact(f.artifactDeps, agentHere, f.org.id, table.id, {
        content: { kind: "table", columns: ["Item"], rows: [["Chá"]] },
        baseVersion: 1,
      }),
    ).rejects.toThrow(/Ask who made it for edit access/);
  });
});
