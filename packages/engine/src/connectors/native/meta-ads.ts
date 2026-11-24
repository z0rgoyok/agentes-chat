import type { ConnectionSecret } from "../connections";
import { graphAnswer, graphFetch } from "./meta";
import { json, type NativeCall, NativeError, type NativeService, type NativeTool, pageSize, str } from "./types";

/**
 * Meta Ads (ADR 0170): the ad accounts a business shares with this server's Meta app through Facebook Login for
 * Business (a configuration, `CONNECTOR_META_ADS_CONFIG_ID`), whose system-user token doesn't expire. Nothing spends
 * without a person: campaigns, ad sets and ads are always created paused, `update` never touches status or budget,
 * and `activate` and `set_budget` ask every time.
 */

export const MARKETING_API_VERSION = "v27.0";
const API = `https://graph.facebook.com/${MARKETING_API_VERSION}`;
/** Meta asks apps to say who calls; ours is the product, not a person. */
const USER_AGENT = "agentes.chat-agent";
const CAMPAIGN_FIELDS = "id,name,objective,status,effective_status,daily_budget,lifetime_budget,created_time";
const AD_SET_FIELDS =
  "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event";
const AD_FIELDS = "id,name,adset_id,campaign_id,status,effective_status,creative{id,name}";
/** What `update` may change: never status or money. */
const UPDATABLE = new Set([
  "name",
  "targeting",
  "creative",
  "optimization_goal",
  "bid_strategy",
  "end_time",
  "start_time",
]);

const tokenOf = (secret: ConnectionSecret) => {
  if (!secret.accessToken)
    throw new NativeError("connector.needs_reconnect", "The Meta sign-in is missing: reconnect it.");
  return secret.accessToken;
};

async function adsCall<T>(
  call: Pick<NativeCall, "http" | "secret">,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  writes = false,
): Promise<T> {
  const flat = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    flat.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await graphFetch(
    call.http,
    `${API}${path}${method === "GET" && flat.size ? `?${flat}` : ""}`,
    {
      method,
      headers: {
        authorization: `Bearer ${tokenOf(call.secret)}`,
        "user-agent": USER_AGENT,
        ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(method === "GET" ? {} : { body: flat }),
    },
    "Meta",
    writes,
  );
  return graphAnswer<T>(res, "Meta", writes);
}

/** `act_123` from `123` or `act_123`. */
const account = (v: unknown) => {
  const raw = str(v).trim();
  if (!/^(act_)?\d{1,30}$/.test(raw))
    throw new NativeError("connector.refused", "Give the ad account as act_<number> (list_ad_accounts).");
  return raw.startsWith("act_") ? raw : `act_${raw}`;
};
const objectId = (v: unknown) => {
  const raw = str(v).trim();
  if (!/^\d{1,30}$/.test(raw)) throw new NativeError("connector.refused", "Give the id as Meta shows it (digits).");
  return raw;
};

const accountInput = { type: "string", description: "The ad account, act_<number> (list_ad_accounts)." } as const;
const idInput = {
  type: "string",
  pattern: "^[0-9]{1,30}$",
  description: "A campaign's, ad set's or ad's id.",
} as const;
const limitInput = { type: "integer", minimum: 1, maximum: 50, description: "How many (default 10)." } as const;
const nameInput = { type: "string", minLength: 1, maxLength: 400 } as const;
const moneyInput = {
  type: "integer",
  minimum: 100,
  description: "In the ad account's currency's smallest unit (cents): 5000 is 50.00.",
} as const;

const list = (path: string, fields: string) => async (input: Record<string, unknown>, call: NativeCall) => {
  const page = await adsCall<{ data?: unknown[] }>(call, "GET", path, { fields, limit: String(pageSize(input.limit)) });
  return json(page.data ?? []);
};

const created = (what: string, answer: { id?: string }) => ({
  content: `Created the ${what} ${answer.id ?? ""}, paused: nothing spends until a person approves activate.`.replace(
    "  ",
    " ",
  ),
  data: { id: answer.id ?? null },
});

const tools: Record<string, NativeTool> = {
  list_ad_accounts: {
    description: "The ad accounts this connection reaches: id (act_…), name, status, currency and amount spent.",
    input: { properties: { limit: limitInput } },
    run: list("/me/adaccounts", "id,name,account_status,currency,amount_spent,timezone_name"),
  },
  list_campaigns: {
    description: "An ad account's campaigns, with status and budgets.",
    input: { properties: { account: accountInput, limit: limitInput }, required: ["account"] },
    run: (input, call) => list(`/${account(input.account)}/campaigns`, CAMPAIGN_FIELDS)(input, call),
  },
  list_ad_sets: {
    description: "The ad sets of an ad account, or of one campaign (campaign_id).",
    input: {
      properties: { account: accountInput, campaign_id: idInput, limit: limitInput },
      required: ["account"],
    },
    run: (input, call) =>
      list(
        input.campaign_id ? `/${objectId(input.campaign_id)}/adsets` : `/${account(input.account)}/adsets`,
        AD_SET_FIELDS,
      )(input, call),
  },
  list_ads: {
    description: "The ads of an ad account, or of one ad set (adset_id).",
    input: { properties: { account: accountInput, adset_id: idInput, limit: limitInput }, required: ["account"] },
    run: (input, call) =>
      list(input.adset_id ? `/${objectId(input.adset_id)}/ads` : `/${account(input.account)}/ads`, AD_FIELDS)(
        input,
        call,
      ),
  },
  get_insights: {
    description:
      "Results of an ad account, campaign, ad set or ad: spend, impressions, reach, clicks, CTR, CPC and actions, for a period (date_preset: today, yesterday, last_7d, last_30d, this_month, last_month, maximum).",
    input: {
      properties: {
        id: { type: "string", description: "act_<number>, or a campaign's, ad set's or ad's id." },
        date_preset: {
          type: "string",
          enum: ["today", "yesterday", "last_7d", "last_30d", "this_month", "last_month", "maximum"],
        },
        level: { type: "string", enum: ["account", "campaign", "adset", "ad"], description: "Break it down by." },
      },
      required: ["id"],
    },
    async run(input, call) {
      const id = str(input.id).startsWith("act_") ? account(input.id) : objectId(input.id);
      const page = await adsCall<{ data?: unknown[] }>(call, "GET", `/${id}/insights`, {
        fields:
          "spend,impressions,reach,clicks,ctr,cpc,cpm,actions,campaign_name,adset_name,ad_name,date_start,date_stop",
        date_preset: str(input.date_preset) || "last_7d",
        ...(str(input.level) ? { level: str(input.level) } : {}),
        limit: "50",
      });
      return json(page.data ?? []);
    },
  },
  create_campaign: {
    description:
      "Create a campaign, paused. objective: OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_APP_PROMOTION or OUTCOME_SALES. special_ad_categories only when it is about credit, employment, housing or politics.",
    input: {
      properties: {
        account: accountInput,
        name: nameInput,
        objective: {
          type: "string",
          enum: [
            "OUTCOME_AWARENESS",
            "OUTCOME_TRAFFIC",
            "OUTCOME_ENGAGEMENT",
            "OUTCOME_LEADS",
            "OUTCOME_APP_PROMOTION",
            "OUTCOME_SALES",
          ],
        },
        special_ad_categories: {
          type: "array",
          items: { type: "string", enum: ["CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS"] },
        },
      },
      required: ["account", "name", "objective"],
    },
    async run(input, call) {
      const answer = await adsCall<{ id?: string }>(
        call,
        "POST",
        `/${account(input.account)}/campaigns`,
        {
          name: str(input.name),
          objective: str(input.objective),
          status: "PAUSED",
          special_ad_categories: Array.isArray(input.special_ad_categories) ? input.special_ad_categories : [],
        },
        true,
      );
      return created("campaign", answer);
    },
  },
  create_ad_set: {
    description:
      'Create an ad set in a campaign, paused, with its budget (daily or lifetime, in cents), optimization goal, billing event and targeting (Meta\'s targeting object, e.g. {"geo_locations":{"countries":["BR"]},"age_min":18}).',
    input: {
      properties: {
        account: accountInput,
        campaign_id: idInput,
        name: nameInput,
        daily_budget: moneyInput,
        lifetime_budget: moneyInput,
        optimization_goal: {
          type: "string",
          description: "LINK_CLICKS, REACH, IMPRESSIONS, LANDING_PAGE_VIEWS, LEAD_GENERATION, OFFSITE_CONVERSIONS…",
        },
        billing_event: { type: "string", description: "IMPRESSIONS (the usual) or LINK_CLICKS." },
        targeting: { type: "object" },
        start_time: { type: "string", description: "ISO 8601." },
        end_time: { type: "string", description: "ISO 8601 (needed with lifetime_budget)." },
      },
      required: ["account", "campaign_id", "name", "optimization_goal", "billing_event", "targeting"],
    },
    async run(input, call) {
      const answer = await adsCall<{ id?: string }>(
        call,
        "POST",
        `/${account(input.account)}/adsets`,
        {
          campaign_id: objectId(input.campaign_id),
          name: str(input.name),
          status: "PAUSED",
          daily_budget: input.daily_budget,
          lifetime_budget: input.lifetime_budget,
          optimization_goal: str(input.optimization_goal),
          billing_event: str(input.billing_event),
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          targeting: input.targeting,
          start_time: str(input.start_time) || undefined,
          end_time: str(input.end_time) || undefined,
        },
        true,
      );
      return created("ad set", answer);
    },
  },
  create_ad: {
    description:
      "Create an ad in an ad set, paused, from an existing creative (creative_id) or a new one (creative: Meta's ad creative object, e.g. with object_story_spec).",
    input: {
      properties: {
        account: accountInput,
        adset_id: idInput,
        name: nameInput,
        creative_id: idInput,
        creative: { type: "object" },
      },
      required: ["account", "adset_id", "name"],
    },
    async run(input, call) {
      const creative = str(input.creative_id) ? { creative_id: objectId(input.creative_id) } : input.creative;
      if (!creative) return { content: "Give creative_id or creative.", isError: true };
      const answer = await adsCall<{ id?: string }>(
        call,
        "POST",
        `/${account(input.account)}/ads`,
        { adset_id: objectId(input.adset_id), name: str(input.name), status: "PAUSED", creative },
        true,
      );
      return created("ad", answer);
    },
  },
  update: {
    description:
      "Change a campaign's, ad set's or ad's name, targeting, creative, optimization goal, bid strategy or dates. Never its status or budget: those are pause, activate and set_budget.",
    input: {
      properties: { id: idInput, fields: { type: "object", description: "What to change." } },
      required: ["id", "fields"],
    },
    async run(input, call) {
      const fields = (input.fields && typeof input.fields === "object" ? input.fields : {}) as Record<string, unknown>;
      const refused = Object.keys(fields).filter((k) => !UPDATABLE.has(k));
      if (refused.length > 0 || Object.keys(fields).length === 0) {
        return {
          content: `Not changed: update takes ${[...UPDATABLE].join(", ")}${refused.length ? `, not ${refused.join(", ")}` : ""}. Status and budget go through pause, activate and set_budget.`,
          isError: true,
        };
      }
      await adsCall(call, "POST", `/${objectId(input.id)}`, fields, true);
      return { content: "Updated." };
    },
  },
  pause: {
    description: "Pause a campaign, ad set or ad: it stops spending.",
    input: { properties: { id: idInput }, required: ["id"] },
    async run(input, call) {
      await adsCall(call, "POST", `/${objectId(input.id)}`, { status: "PAUSED" }, true);
      return { content: "Paused." };
    },
  },
  activate: {
    description: "Turn on a campaign, ad set or ad: it starts spending. Asks a person every time.",
    input: { properties: { id: idInput }, required: ["id"] },
    async run(input, call) {
      await adsCall(call, "POST", `/${objectId(input.id)}`, { status: "ACTIVE" }, true);
      return { content: "Active: it spends from now on." };
    },
  },
  set_budget: {
    description:
      "Set a campaign's or ad set's daily or lifetime budget, in cents. Asks a person every time; Meta allows 4 budget changes an hour per ad set.",
    input: {
      properties: { id: idInput, daily_budget: moneyInput, lifetime_budget: moneyInput },
      required: ["id"],
    },
    async run(input, call) {
      if (input.daily_budget === undefined && input.lifetime_budget === undefined) {
        return { content: "Give daily_budget or lifetime_budget.", isError: true };
      }
      await adsCall(
        call,
        "POST",
        `/${objectId(input.id)}`,
        { daily_budget: input.daily_budget, lifetime_budget: input.lifetime_budget },
        true,
      );
      return { content: "Budget set." };
    },
  },
  archive: {
    description: "Archive a campaign, ad set or ad: it stops and leaves the lists, its results kept.",
    input: { properties: { id: idInput }, required: ["id"] },
    async run(input, call) {
      await adsCall(call, "POST", `/${objectId(input.id)}`, { status: "ARCHIVED" }, true);
      return { content: "Archived." };
    },
  },
  delete: {
    description: "Delete a campaign, ad set or ad. It can't be undone.",
    input: { properties: { id: idInput }, required: ["id"] },
    async run(input, call) {
      await adsCall(call, "DELETE", `/${objectId(input.id)}`, {}, true);
      return { content: "Deleted." };
    },
  },
};

export const metaAds: NativeService = {
  tools,
  async account(secret, http) {
    const me = await adsCall<{ id?: string; name?: string }>({ http, secret }, "GET", "/me", { fields: "id,name" });
    if (!me.id) throw new NativeError("connector.failed", "Meta didn't say which account signed in. Try again.");
    return { label: me.name ?? me.id, id: me.id };
  },
};
