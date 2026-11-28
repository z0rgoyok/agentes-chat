import type { PubSub } from "@agenteschat/adapters";
import { and, asc, eq, inArray, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { recordAgentActions } from "./agent-actions";
import { sniffModelImage } from "./avatars";
import { readsOrMayJoin } from "./channels";
import { cardPlace } from "./consultations";
import { learnTrust, ownWords } from "./context/learn";
import { changeSkillAsAgent, createSkillAsAgent } from "./context/learned-skills";
import { reviewAskedSkill } from "./context/proposal-review";
import { askedWords } from "./context/proposals";
import type { ContextDeps } from "./context/summaries";
import { memoryResult } from "./context/tools";
import { publishMessageCreated } from "./events";
import { copyToComputer, type StoredFile } from "./file-pulls";
import { cutText, formatBytes } from "./format";
import type { Judge } from "./judge";
import { insertMessage, messageView } from "./messages";
import { can, getMembership } from "./organizations";
import { personBehindCall } from "./requester";
import { bodyCode } from "./run-tools";
import { replyThreadOf } from "./runs";
import { type SandboxDeps, withSandbox } from "./sandbox";
import { cardsLeft, hopOf, NOBODY_READS, REQUEST_SETTINGS_TOOL, whoActs } from "./setup-tools";
import { recordSkillUse } from "./skill-library";
import { updateSkillFromSource } from "./skill-updates";
import {
  agentSkillByName,
  notKeptReason,
  parseGithubUrl,
  SKILL_LIMITS,
  type SkillDeps,
  skillFile,
  skillFilesOf,
  skillHolders,
  skillPersonMayChange,
  skillZipOfFile,
} from "./skills";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

export const OFFER_INSTALL_SKILL_TOOL = "offer_install_skill";
/** A skill of the agent's own, made when a person asks (ADR 0120, addendum of 2026-11-14). */
export const CREATE_SKILL_TOOL = "create_skill";
export const UPDATE_SKILL_FROM_SOURCE_TOOL = "update_skill_from_source";
/** An install card's `bodyCode` (`chat.body.action_install_skill`), and an update card's (`action_update_skills`). */
export const INSTALL_SKILL_CARD = "action_install_skill";
export const UPDATE_SKILLS_CARD = "action_update_skills";
/** Skills one `update_skill_from_source` reads (each a repository's archive), the least recently read first. */
export const MAX_SKILL_UPDATES_PER_CALL = 10;

/**
 * "Instalar skill": its button opens the app's install dialog with the skill read, from its GitHub link (`url`) or from
 * a .zip sent in the conversation (`file`, its Drive id, its `name` and the `skills` its SKILL.md files name), to pick
 * and install.
 */
export interface InstallSkillCard {
  kind: "install_skill";
  forUserId: string | null;
  params: { url: string; why: string } | { file: string; name: string; skills: string[]; why: string };
}

/**
 * "Atualizar skills": the skills to update from their links, or whose update waits because it changes what runs; its
 * buttons open each one in Skills, where who manages skills updates it or applies what waits.
 */
export interface UpdateSkillsCard {
  kind: "update_skills";
  forUserId: string | null;
  params: { skillIds: string[]; why: string };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** How an agent asks for a skill installed here that it doesn't have on: its own settings card, never by hand. */
const ASK_FOR_SKILL = `ask for it with ${REQUEST_SETTINGS_TOOL} (add_skills), a card a person approves.`;

/** Why a skill isn't one of the agent's, with the way to get it when it is installed here. */
async function notYours(ctx: ToolContext, name: string): Promise<ToolOutput> {
  const [installed] = await ctx.db
    .select({ name: schema.skills.name })
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.orgId, ctx.orgId),
        eq(schema.skills.slug, name.trim().toLowerCase()),
        isNull(schema.skills.deletedAt),
        isNull(schema.skills.ownerUserId),
      ),
    );
  return {
    content: installed
      ? `The skill ${installed.name} is installed here but not on for you: ${ASK_FOR_SKILL}`
      : `No skill named ${name} is enabled for you.`,
    isError: true,
  };
}

export const LOAD_SKILL_TOOL = "load_skill";

/**
 * A skill this run reads: one of the agent's own, else one the person behind the run may change (`managed`), so the
 * agent reads and fixes other agents' skills for who manages them.
 */
async function skillToRead(ctx: ToolContext, name: string) {
  const mine = await agentSkillByName(ctx.db, ctx.orgId, ctx.agentId, name, ctx.runId);
  if (mine) return { skill: mine, managed: false };
  const person = await personBehindCall(ctx);
  const skill = person ? await skillPersonMayChange(ctx.db, ctx.orgId, name, person) : null;
  return skill ? { skill, managed: true } : null;
}

/** The files `load_skill` names one by one: the list goes into the conversation of every run that loads the skill. */
const LISTED_FILES = 100;

/** A skill's files for its agent, one a line. Past `LISTED_FILES`, the shallowest ones, and the rest as their folders. */
function skillFileList(files: Awaited<ReturnType<typeof skillFilesOf>>) {
  if (files.length === 0) return "(no files)";
  const line = (f: (typeof files)[number]) => {
    if (f.status === "stored") return `- ${f.path} (${f.mime}, ${formatBytes(f.size)})`;
    if (f.status === "script") {
      return `- ${f.path} (script: runs with run_skill_script if you have the code environment; its content is not shown)`;
    }
    return `- ${notKeptReason(f, files)}`;
  };
  if (files.length <= LISTED_FILES) return files.map(line).join("\n");
  const depth = (path: string) => path.split("/").length;
  const shallow = [...files].sort((a, b) => depth(a.path) - depth(b.path));
  const folded = new Map<string, number>();
  for (const f of shallow.slice(LISTED_FILES)) {
    const folder = `${f.path.split("/").slice(0, -1).slice(0, 2).join("/") || "."}/`;
    folded.set(folder, (folded.get(folder) ?? 0) + 1);
  }
  const folders = [...folded].map(
    ([path, count]) => `- ${path} (${count} more, read_skill_file on this path lists them)`,
  );
  return [...shallow.slice(0, LISTED_FILES).map(line), ...folders].join("\n");
}

/**
 * Skills through the Tool Gateway (`skills:read`, on by default):
 * `load_skill` returns a skill's instructions and its files, and
 * `read_skill_file` one of them: text as text, an image as an image on a model brain, and on a computer brain (or
 * any file that isn't text) the file saved to `.skills/{name}/` on the agent's computer, where its own tools open it.
 * Only skills enabled for the agent; scripts are never shown: `run_skill_script` (sandbox tools, ADR 0021) runs them.
 * `computer`: reaching the agent's computer (none: files that aren't text are described only).
 */
export function createSkillToolSource(
  deps: SkillDeps & { pubsub?: PubSub; judge?: Judge; computer?: SandboxDeps; context?: ContextDeps },
): ToolSource {
  /** Saves a skill's file on the agent's computer: its path there, or why it couldn't be. */
  const saveOnComputer = async (ctx: ToolContext, path: string, file: StoredFile) => {
    const computer = deps.computer;
    if (!computer) return { why: "There is no computer here to save it on." };
    const pull = { db: ctx.db, blobs: deps.blobs, publicUrl: computer.publicUrl };
    return withSandbox(computer, ctx, (c) => copyToComputer(pull, ctx, c, path, file)).then(
      () => ({ saved: path }),
      (error: unknown) => ({ why: error instanceof Error ? error.message : String(error) }),
    );
  };
  /** Posts an install or update card where it goes (`cardPlace`). */
  const postCard = async (
    ctx: ToolContext,
    at: { channelId: string; threadId: string | null },
    body: string,
    code: string,
    card: InstallSkillCard | UpdateSkillsCard,
  ) => {
    const message = await insertMessage(ctx.db, {
      orgId: ctx.orgId,
      ...at,
      author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
      body,
      meta: { ...bodyCode(code), actionCard: card },
    });
    if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
    return message;
  };
  /** Posts the install card (`offer_install_skill`), a link's or a .zip's, where someone who may install skills reads it. */
  const offerInstall = async (
    ctx: ToolContext,
    body: string,
    params: InstallSkillCard["params"],
  ): Promise<ToolOutput> => {
    const at = await cardPlace(ctx);
    if (!at) return NOBODY_READS;
    const forUserId = await personBehindCall(ctx);
    const acts = await whoActs(ctx, forUserId, "manage_agents", at.channelId);
    if (!acts) {
      return {
        content:
          "Nothing was posted: installing skills is for people who manage agents, and none of them can open this conversation. Tell the person, and offer to ask one (request_approval, or in a channel an admin reads).",
        isError: true,
      };
    }
    const full = await cardsLeft(ctx);
    if (full) return full;
    const message = await postCard(ctx, at, body, INSTALL_SKILL_CARD, { kind: "install_skill", forUserId, params });
    return {
      content: `Posted the card to install the skill: a person picks and installs it in the app's dialog.${acts === "person" ? "" : " The person who asked can't install skills: someone who manages agents here does it from the card. Say so."} Installed from the card, it goes on for you too. Don't install it anywhere yourself, and don't say it's installed until it shows in your skills.`,
      data: { actionCard: { messageId: message.id } },
    };
  };
  /** The install card for a .zip sent in the conversation, read as the agent reads it: only one with a skill in it. */
  const offerFromFile = async (ctx: ToolContext, fileId: string, why: string): Promise<ToolOutput> => {
    let zip: Awaited<ReturnType<typeof skillZipOfFile>>;
    try {
      zip = await skillZipOfFile(
        { db: ctx.db, blobs: deps.blobs },
        {
          type: "agent",
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          threadId: replyThreadOf(ctx),
          runId: ctx.runId,
        },
        ctx.orgId,
        fileId,
      );
    } catch (error) {
      return {
        content: `Nothing was posted: ${error instanceof Error ? error.message : String(error)}. \`file\` is a .zip sent in this conversation, by the id read_artifact names.`,
        isError: true,
      };
    }
    if (zip.skillFiles === 0) {
      return {
        content: `Nothing was posted: ${zip.name} holds no SKILL.md, so no skill installs from it. Tell the person what it holds instead.`,
        isError: true,
      };
    }
    const installed =
      zip.names.length === 0
        ? []
        : await ctx.db
            .select({ name: schema.skills.name })
            .from(schema.skills)
            .where(
              and(
                eq(schema.skills.orgId, ctx.orgId),
                inArray(schema.skills.name, zip.names),
                isNull(schema.skills.deletedAt),
                isNull(schema.skills.ownerUserId),
              ),
            );
    if (zip.names.length > 0 && installed.length >= zip.names.length && zip.skillFiles === zip.names.length) {
      const names = installed.map((k) => k.name).join(", ");
      return {
        content: `${zip.name} is already installed here (${names}). To replace it with this .zip, a person who manages skills uploads it on the Skills page; to use one that isn't on for you, ${ASK_FOR_SKILL}`,
        isError: true,
      };
    }
    return offerInstall(ctx, `Install the skill${zip.skillFiles > 1 ? "s" : ""} in ${zip.name}: ${why}`, {
      file: fileId,
      name: zip.name,
      skills: zip.names,
      why,
    });
  };
  const tools: ToolDefinition[] = [
    {
      name: LOAD_SKILL_TOOL,
      description:
        "Load one of your skills (from 'Available skills') before doing a task it covers: returns its instructions and the files you can read. When the person who asked manages skills, it also reads any skill of the workspace, to change it or give it to agents.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const found = await skillToRead(ctx, str(input.name));
          if (!found) return notYours(ctx, str(input.name));
          const { skill } = found;
          const list = skillFileList(await skillFilesOf(ctx.db, skill));
          if (found.managed) {
            const holders = await skillHolders(ctx.db, ctx.orgId, skill.id);
            const on = holders.length ? holders.map((h) => `@${h}`).join(", ") : "no agent";
            return {
              content: `Skill "${skill.name}" (v${skill.version}) is not on for you: you read it to manage it for the person who asked, never to follow it yourself (to use it yourself, ${ASK_FOR_SKILL.slice(0, -1)}). On for: ${on}. Change it with update_skill; give it to agents or take it away with propose_settings_change (add_skills, remove_skills).\n\n${skill.body}\n\nFiles (read with read_skill_file):\n${list}`,
              data: { skill: { id: skill.id, name: skill.name, version: skill.version } },
            };
          }
          // Use keeps an agent-made skill from being archived for disuse (ADR 0120), and shows in Skills: how often
          // and where it was used.
          await ctx.db
            .update(schema.skills)
            .set({ useCount: sql`${schema.skills.useCount} + 1`, lastUsedAt: new Date() })
            .where(eq(schema.skills.id, skill.id));
          await recordSkillUse(ctx.db, ctx, skill.id);
          return {
            content: `Skill "${skill.name}" (v${skill.version}) loaded.\n\n${skill.body}\n\nFiles (read with read_skill_file):\n${list}`,
            data: { skill: { id: skill.id, name: skill.name, version: skill.version } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "read_skill_file",
      description:
        "Read a file of one of your skills (references, templates, examples, images): text comes as text, an image as an image you see; other files are saved to .skills/{name}/ on your computer, when you have one. A path ending in / lists that folder.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64 },
          path: { type: "string", minLength: 1, maxLength: 300 },
        },
        required: ["name", "path"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const skill = (await skillToRead(ctx, str(input.name)))?.skill;
          if (!skill) return notYours(ctx, str(input.name));
          const path = str(input.path);
          if (path.endsWith("/")) {
            const prefix = path === "./" ? "" : path;
            const inside = (await skillFilesOf(ctx.db, skill)).filter((f) => f.path.startsWith(prefix));
            const list = inside.map((f) => f.path).join("\n");
            return { content: cutText(list, SKILL_LIMITS.fileReadChars) || `No files in ${path}` };
          }
          const file = await skillFile(deps, skill, path);
          if (file.text) {
            const text = new TextDecoder().decode(file.data);
            const shown =
              text.length > SKILL_LIMITS.fileReadChars
                ? `${cutText(text, SKILL_LIMITS.fileReadChars)}\n[truncated]`
                : text;
            return { content: `${skill.name}/${path}:\n${shown}` };
          }
          const about = `${skill.name}/${path} (${file.mime}, ${formatBytes(file.size)})`;
          // By its bytes: a model's API refuses an image sent under another type (a .png that is a JPEG).
          const image = sniffModelImage(file.data);
          const fits = file.data.byteLength <= SKILL_LIMITS.imageBytes;
          // A computer brain (Claude Code, Codex, OpenCode) sees pictures with its own tools, not through ours.
          if (image && fits && !ctx.bridge) {
            return {
              content: `${about}: the image is attached.`,
              images: [{ mediaType: image, data: Buffer.from(file.data).toString("base64") }],
            };
          }
          const tooLarge =
            image && !ctx.bridge
              ? ` It is too large to show you here (max ${formatBytes(SKILL_LIMITS.imageBytes)}).`
              : "";
          const result = await saveOnComputer(ctx, `.skills/${skill.name}/${path}`, file.stored);
          if ("saved" in result) {
            return {
              content: `${about}:${tooLarge} saved to ${result.saved} in your folder on your computer: open it there with your own tools${image && ctx.bridge ? ", which show images" : ""}.`,
              data: { path: result.saved },
            };
          }
          return {
            content: `${about}: not text, so its content isn't shown here.${tooLarge} Not saved on your computer: ${result.why}`,
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "update_skill",
      description:
        "Fix a skill you loaded this turn: `body` its new body, `files` whole text files to change or add (read them first). Also another agent's skill, when the person who asked manages skills: load it first. Files that run go through a quick review first. No credentials.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64 },
          body: { type: "string", maxLength: 50_000 },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string", minLength: 1, maxLength: 300 },
                content: { type: "string", maxLength: 200_000 },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: `Fix the skill ${str(input.name)}` }),
      async execute(input, ctx) {
        try {
          const files = Array.isArray(input.files)
            ? (input.files as { path?: unknown; content?: unknown }[]).map((f) => ({
                path: str(f.path),
                content: str(f.content),
              }))
            : [];
          if (files.length > 10) return { content: "At most 10 files at a time.", isError: true };
          const { trust, person: behind } = await learnTrust(ctx);
          // A card under the reply only reaches them where they read it: in the agents' DM (a hand-off), the inbox does.
          const person =
            behind && (await readsOrMayJoin(ctx.db, ctx.orgId, behind, [ctx.channelId])).has(ctx.channelId)
              ? behind
              : null;
          const words = await ownWords(ctx);
          const decides = !!words && can(await getMembership(ctx.db, words, ctx.orgId), "manage_agents");
          const change = await changeSkillAsAgent(
            { db: ctx.db, pubsub: deps.pubsub, judge: deps.judge, blobs: deps.blobs },
            ctx,
            str(input.name),
            { body: typeof input.body === "string" ? input.body : undefined, files },
            trust,
            { person, decides, words },
          );
          const waits = change.scripts.length
            ? ` ${change.scripts.join(", ")} run${change.scripts.length === 1 ? "s" : ""} as code, so that change goes through a quick review that applies it in a moment if it makes sense; its card shows the outcome.`
            : "";
          const membership = person ? await getMembership(ctx.db, person, ctx.orgId) : null;
          /** With a person behind the run its card sits under the reply; with nobody, the deciders' inbox row is the way in. */
          const carded = (content: string) => {
            const [first] = change.proposalIds;
            if (!person || !first) return { content };
            return memoryResult(ctx, content, {
              action: "proposed",
              itemId: first,
              text: str(input.name),
              requestedByUserId: person,
              proposalId: first,
              proposalIds: change.proposalIds,
              canDecide: can(membership, "manage_agents"),
            });
          };
          if (change.action === "updated")
            return carded(`Updated ${change.skill?.name} (v${change.skill?.version}).${waits}`);
          if (change.action === "unchanged") return { content: "Nothing changed: it is the same." };
          const why =
            change.why === "outside"
              ? "This turn read outside content (the web, mail or a connected app), so the change"
              : "The change";
          return carded(
            `${why} goes through a quick review that applies it in a moment if it makes sense; its card shows the outcome.${waits} Use your fix in this turn.`,
          );
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: CREATE_SKILL_TOOL,
      description:
        "Create a skill of your own when a person asks you to make one ('transforma isso numa skill', 'make a skill of how you did this'): `name` kebab-case for the kind of task, `description` when to use it, `body` Markdown with the steps first, then the pitfalls, in the person's language. It goes on for you at once and shows in the workspace's Skills, where people undo it or give it to other agents. This is the way to make a skill here: never a repository, a link or your CLI's own skills folder. A skill someone sends (a .zip, a GitHub link) installs whole with offer_install_skill: never rewrite it here. No credentials or where they are kept: say which key it needs from a person. Add text files to it later with update_skill.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
          description: { type: "string", minLength: 1, maxLength: 1024 },
          body: { type: "string", minLength: 1, maxLength: 50_000 },
        },
        required: ["name", "description", "body"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: `Create the skill ${str(input.name)}` }),
      async execute(input, ctx) {
        try {
          const { trust, person } = await learnTrust(ctx);
          if (!person) {
            return {
              content:
                "Only a person's request makes a skill. Save how you did it with save_how_to: used again and again, it becomes a skill by itself.",
              isError: true,
            };
          }
          // After outside content (the web, mail, a connected app, or a conversation that relays them) the skill is
          // made only when the review reads it as the person's own request (ADR 0219): a skill loads as trusted
          // instructions, so nothing the content slipped in may ride along.
          if (trust === "low") {
            const verdict = deps.context
              ? await reviewAskedSkill(deps.context, {
                  orgId: ctx.orgId,
                  agentId: ctx.agentId,
                  runId: ctx.runId,
                  name: str(input.name),
                  description: str(input.description),
                  body: str(input.body),
                  words: await askedWords(ctx.db, ctx, person),
                })
              : null;
            if (!verdict)
              return {
                content:
                  "This turn read outside content, and the check that lets a skill through after it couldn't run (no AI account with an API key for it, and Jev didn't answer). Don't try again in this turn: tell the person it wasn't made for that reason, and that an admin can add an AI account with an API key in Settings › AI and usage, or they can write the skill themselves on the Skills page.",
                isError: true,
                data: { code: "skill.outside_content" },
              };
            if (!verdict.apply)
              return {
                content: `Not made: the check after outside content left it out${verdict.why ? ` (${verdict.why})` : ""}. Don't call create_skill again with the same text: tell the person what was left out and why, and make only what they asked for.`,
                isError: true,
                data: { code: "skill.left_out" },
              };
          }
          const skill = await createSkillAsAgent({ db: ctx.db, judge: deps.judge }, ctx, {
            name: str(input.name),
            description: str(input.description),
            body: str(input.body),
            person,
          });
          return {
            content: skill.ownerUserId
              ? `Created the skill ${skill.name}, the personal skill of the person who asked: you use it only when they ask. It shows in their Skills under Personal, where they undo it. Load it with load_skill when a task matches.`
              : `Created the skill ${skill.name}, on for you now. It shows in your skills and on the Skills page, where people undo it or give it to other agents. Load it with load_skill when a task matches.`,
            data: { skill: { id: skill.id, name: skill.name, version: skill.version } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: OFFER_INSTALL_SKILL_TOOL,
      description:
        "Offer to install a skill for the workspace with a card in this conversation: its button opens the app's install dialog (the Skills page's) with the skill already read, from its GitHub link (`url`) or from a .zip sent in the conversation (`file`: its Drive id, as read_artifact names it), where a person who manages skills picks it and installs it, since a skill adds instructions and scripts agents run. It installs whole, files and scripts with it. Installed from the card, it goes on for you. Use it whenever someone asks to install or add a skill that isn't installed here (one that is, but not on for you: request_settings_change), and for a skill someone sends as a .zip: never rewrite it with create_skill, which keeps only text. Never install one into your CLI's own skills folder on your computer (~/.claude/skills, ~/.codex/skills, .agents/skills…) for the workspace: only you would have it there, nobody reviews it and it never updates.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            minLength: 19,
            maxLength: 2000,
            description: "The skill's GitHub link: a repository, a folder or its SKILL.md.",
          },
          file: {
            type: "string",
            minLength: 36,
            maxLength: 36,
            description: "In place of `url`: the Drive id of a .zip of the skill sent in this conversation.",
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "One short line on the card for the person, in their language: what the skill does.",
          },
        },
        required: ["why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` what the skill does: one short line.", isError: true };
          const url = str(input.url).trim();
          const fileId = str(input.file).trim();
          if (Boolean(url) === Boolean(fileId)) {
            return {
              content: "Give one of `url` (the skill's GitHub link) or `file` (the Drive id of its .zip sent here).",
              isError: true,
            };
          }
          if (fileId) return await offerFromFile(ctx, fileId, why);
          try {
            parseGithubUrl(url);
          } catch {
            return {
              content:
                "Only GitHub links and .zip files install as skills (a repository, a folder in it or a SKILL.md; a .zip sent in the conversation goes in `file`). Ask the person for the skill's GitHub link or its .zip.",
              isError: true,
            };
          }
          const [installed] = await ctx.db
            .select({ name: schema.skills.name })
            .from(schema.skills)
            .where(
              and(
                eq(schema.skills.orgId, ctx.orgId),
                eq(schema.skills.sourceUrl, url),
                isNull(schema.skills.deletedAt),
                isNull(schema.skills.ownerUserId),
              ),
            );
          if (installed) {
            const on = await agentSkillByName(ctx.db, ctx.orgId, ctx.agentId, installed.name, ctx.runId);
            return {
              content: `That link is already installed as the skill ${installed.name}, ${on ? "on for you. To bring it up to date, use update_skill_from_source." : `not on for you: ${ASK_FOR_SKILL}`}`,
              isError: true,
            };
          }
          return await offerInstall(ctx, `Install the skill at ${url}: ${why}`, { url, why });
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: UPDATE_SKILL_FROM_SOURCE_TOOL,
      description:
        "Update the workspace's skills from the links they were installed from, when someone asks ('atualiza a skill deploy', 'update every skill'): `name` one skill, or `all` for every skill installed from a link. New text applies at once (the person sees it with Undo); an update that adds or changes scripts or other files that run waits for a person who manages skills, on a card. When the person who asked can't manage skills, the card goes to someone who can.",
      scope: "skills:read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64, description: "A skill's name, or `all`." },
          why: {
            type: "string",
            maxLength: 300,
            description: "One short line for a card, in the person's language, when one is posted.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      describe: (input) => ({
        title: `Update ${str(input.name) === "all" ? "the skills" : `the skill ${str(input.name)}`}`,
      }),
      async execute(input, ctx) {
        try {
          const forUserId = await personBehindCall(ctx);
          if (!forUserId) return { content: "Only a person's request updates skills.", isError: true };
          const name = str(input.name).trim();
          const all = name === "all";
          const rows = await ctx.db
            .select()
            .from(schema.skills)
            .where(
              and(
                eq(schema.skills.orgId, ctx.orgId),
                isNull(schema.skills.deletedAt),
                isNull(schema.skills.ownerUserId),
                isNotNull(schema.skills.sourceUrl),
                all ? undefined : eq(schema.skills.slug, name),
              ),
            )
            .orderBy(sql`${schema.skills.checkedAt} asc nulls first`, asc(schema.skills.name))
            .limit(MAX_SKILL_UPDATES_PER_CALL);
          if (rows.length === 0) {
            return {
              content: all
                ? "No skill of this workspace was installed from a link, so none updates from one."
                : `No skill named ${name} was installed from a link: only those update from where they came.`,
              isError: true,
            };
          }
          const why = str(input.why).trim();
          const names = (ids: string[]) => ids.map((id) => rows.find((r) => r.id === id)?.name ?? "").join(", ");
          const at = await cardPlace(ctx);
          if (!can(await getMembership(ctx.db, forUserId, ctx.orgId), "manage_agents")) {
            if (!at) return NOBODY_READS;
            const acts = await whoActs(ctx, forUserId, "manage_agents", at.channelId);
            if (!acts) {
              return {
                content:
                  "Nothing was updated: updating skills is for people who manage agents, and none of them can open this conversation. Tell the person, and offer to ask one.",
                isError: true,
              };
            }
            const full = await cardsLeft(ctx);
            if (full) return full;
            const ids = rows.map((r) => r.id);
            const message = await postCard(
              ctx,
              at,
              `Update ${names(ids)}${why ? `: ${why}` : ""}`,
              UPDATE_SKILLS_CARD,
              {
                kind: "update_skills",
                forUserId,
                params: { skillIds: ids, why },
              },
            );
            return {
              content: `The person who asked can't update skills: posted a card for someone who manages agents here to update ${names(ids)}. Say so.`,
              data: { actionCard: { messageId: message.id } },
            };
          }
          const lines: string[] = [];
          const waiting: string[] = [];
          for (const row of rows) {
            try {
              const r = await updateSkillFromSource(deps, forUserId, ctx.orgId, row.id);
              if (r.status === "unchanged") lines.push(`${row.name}: already what its link holds (v${row.version}).`);
              else if (r.status === "waiting") {
                waiting.push(row.id);
                const why = [
                  ...(r.scripts.length ? [`adds or changes ${r.scripts.join(", ")}`] : []),
                  ...(r.edited ? ["would replace what agents changed in it"] : []),
                ].join(" and ");
                lines.push(`${row.name}: the update ${why}, so it waits for approval.`);
              } else {
                lines.push(`${row.name}: updated to v${r.skill.version}.`);
                if (ctx.runId) {
                  const s = r.skill;
                  await recordAgentActions(ctx.db, ctx, [
                    {
                      kind: "skill.updated",
                      target: { type: "skill", id: s.id, title: s.name },
                      params: { name: s.name, fromLink: true },
                      before: r.before,
                      after: { version: s.version, body: s.body, description: s.description, metadata: s.metadata },
                    },
                  ]);
                }
              }
            } catch (error) {
              lines.push(`${row.name}: not updated (${error instanceof Error ? error.message : String(error)}).`);
            }
          }
          let card = "";
          if (waiting.length > 0) {
            const full = at ? await cardsLeft(ctx) : NOBODY_READS;
            if (full) card = `\n${full.content}`;
            else if (at) {
              await postCard(
                ctx,
                at,
                `Review the update of ${names(waiting)}${why ? `: ${why}` : ""}`,
                UPDATE_SKILLS_CARD,
                {
                  kind: "update_skills",
                  forUserId,
                  params: { skillIds: waiting, why },
                },
              );
              card = "\nPosted a card: a person who manages skills reviews the files that run and applies it.";
            }
          }
          const more =
            all && rows.length === MAX_SKILL_UPDATES_PER_CALL
              ? `\nRead ${rows.length} skills; call again for the rest.`
              : "";
          return { content: `${lines.join("\n")}${card}${more}` };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "skills", tools: async () => tools };
}
