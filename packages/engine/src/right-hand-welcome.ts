import { and, type Database, type Executor, eq, gt, ne, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { en } from "@agenteschat/i18n/en";
import { personAgentDmKey } from "./dms";
import type { JobDeps } from "./jobs";
import { enqueue } from "./outbox";
import { personLocale } from "./requester";
import { defineLodiLane, type LodiPromptContext } from "./right-hand-lane";
import { lodiFor, lodiSwitches, postFromLodi } from "./right-hand-proactive";
import { orgStanding, workRefusal } from "./standing";
import type { ReplyChips } from "./team-proposals";

/**
 * "Dar boas-vindas a quem entra": one message from the right hand to each person who joins a workspace, once, and
 * what it keeps in mind while they are new. The greeting calls no model.
 *
 * The contract with the rest of the server is `welcomeLane` below: the server reads the job, the prompt block and the
 * switch from it, so nothing else is wired by hand.
 * - `WELCOME_JOB` is queued where a person becomes a member (`queueWelcome`), in that transaction, with
 *   `payload.userId` and one dedupe key per workspace and person, so nobody is greeted twice, a rejoin included.
 * - `postWelcome` is that job. It posts nothing when the workspace turned it off (`lodiSwitches(...).welcomePeople`)
 *   or `lodiFor` says no, and may run twice (`postFromLodi` with `posted`). A job that ends without posting spent
 *   its key: nobody is greeted late.
 * - `newcomerBlock` is a block of the right hand's prompt in its DM with `ctx.personId`, or "". It is read on every
 *   turn there: one statement.
 * - `live` shows the "Dar boas-vindas a quem entra" switch on the right hand's page and adds it to
 *   `update_workspace`. False keeps it off both.
 */

const { agents, channels, messages, organizationMembers, organizationSettings, organizations, users } = schema;

export const WELCOME_JOB = "right_hand.welcome";

/** The greeting's `meta.bodyCode`: the apps word it with `chat.body.welcome_member`. */
export const WELCOME_BODY = "welcome_member";

/** How long after joining a person with no agent of their own is still new to the right hand. */
export const NEWCOMER_DAYS = 30;

/**
 * The areas a person taps under the greeting: the onboarding's own, in its order (the client's `WORK_AREAS`, which
 * this package cannot import). "Something else" is left out, since typing is that answer and the words alone tell the
 * right hand nothing.
 */
const AREAS = Object.keys(en.onboarding.flow.area.options).filter((id) => id !== "other");

/** Their area as the onboarding saved it, when it names one: not skipped, not "something else". */
const areaOf = (workArea: string | null) => (workArea && AREAS.includes(workArea) ? workArea : null);

/** Queues the greeting of someone who just became a member, in the transaction that made them one. */
export const queueWelcome = (tx: Executor, orgId: string, userId: string) =>
  enqueue(tx, { orgId, kind: WELCOME_JOB, payload: { userId }, dedupeKey: `${WELCOME_JOB}:${orgId}:${userId}` });

export async function postWelcome(deps: JobDeps, orgId: string, payload: Record<string, unknown>): Promise<void> {
  const { db } = deps;
  const userId = typeof payload.userId === "string" ? payload.userId : null;
  if (!userId) return;
  if (!(await lodiSwitches(db, orgId)).welcomePeople) return;
  // On a hold nothing answers here: the greeting would promise an agent the person's reply cannot get.
  if (workRefusal(await orgStanding(db, orgId))) return;
  // No row: they left before the job ran.
  const [person] = await db
    .select({ role: organizationMembers.role, workArea: users.workArea, org: organizations.name })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  if (!person) return;
  // An owner has the first-run checklist at the top of this DM, which holds the whole setup: one ask, not two.
  if (person.role === "owner") return;
  const lodi = await lodiFor(db, orgId, userId);
  if (!lodi) return;
  const locale = await personLocale(db, userId);
  const chips: ReplyChips = {
    choices: AREAS.map((id) => serverText(locale, `onboarding.flow.area.options.${id}`)),
    multiple: false,
    step: 1,
    of: 1,
  };
  await postFromLodi(deps, orgId, userId, {
    bodyCode: WELCOME_BODY,
    bodyParams: { org: person.org },
    // Someone whose area the onboarding already knows is not asked to tap it again.
    ...(areaOf(person.workArea) ? {} : { meta: { replyChips: chips } }),
    push: true,
    // Anything already in their conversation with it: they wrote first, or it was restored on a rejoin.
    posted: async (tx, lodiId) =>
      (
        await tx
          .select({ id: messages.id })
          .from(messages)
          .innerJoin(channels, and(eq(channels.orgId, messages.orgId), eq(channels.id, messages.channelId)))
          .where(and(eq(messages.orgId, orgId), eq(channels.dmKey, personAgentDmKey(userId, lodiId))))
          .limit(1)
      ).length > 0,
    lodi,
  });
}

/**
 * What the right hand keeps in mind with someone new: a member who is not an owner (an owner has the first-run
 * checklist), joined in the last `NEWCOMER_DAYS` days and has no agent of their own. Only this person's own data.
 * "" with the workspace's switch off.
 */
export async function newcomerBlock(db: Database, ctx: LodiPromptContext): Promise<string> {
  const [person] = await db
    .select({ workArea: users.workArea })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(organizationSettings, eq(organizationSettings.orgId, organizationMembers.orgId))
    .where(
      and(
        eq(organizationMembers.orgId, ctx.orgId),
        eq(organizationMembers.userId, ctx.personId),
        ne(organizationMembers.role, "owner"),
        gt(organizationMembers.createdAt, sql`now() - make_interval(days => ${NEWCOMER_DAYS})`),
        sql`coalesce(${organizationSettings.welcomePeople}, true)`,
        sql`not exists (select 1 from ${agents}
          where ${agents.orgId} = ${ctx.orgId} and ${agents.ownerUserId} = ${ctx.personId})`,
      ),
    );
  if (!person) return "";
  const area = areaOf(person.workArea);
  return [
    "# Someone new",
    `This person joined the workspace in the last ${NEWCOMER_DAYS} days and has no agent of their own yet.${
      area ? ` They work in ${serverText("en", `onboarding.flow.area.options.${area}`)}.` : ""
    }`,
    "- When they say what they look after, propose ONE agent for it with propose_agent and a first_task to try it on. Never a team and never the interview for them, unless they ask for one.",
    "- At most one question first, and only when what they do is unclear. What they typed comes first.",
    "- Once their agent is made and it has no AI, offer the Connect AI card (offer_connect_ai), once.",
    "- If you already proposed an agent in this conversation, don't propose another unless they ask.",
  ].join("\n");
}

export const welcomeLane = defineLodiLane({
  switch: "welcomePeople",
  live: true,
  jobs: { [WELCOME_JOB]: postWelcome },
  promptBlock: newcomerBlock,
});
