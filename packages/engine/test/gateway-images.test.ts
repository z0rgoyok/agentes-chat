import { afterEach, expect, test } from "bun:test";
import { envPlatformCredentials } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { IMAGE_MODEL_IDS, PROVIDER_IDS, ProviderError } from "@agenteschat/providers";
import { createFakeProvider } from "@agenteschat/providers/testing";
import {
  agentBudgetState,
  agentSpendThisMonth,
  BudgetExceededError,
  createCredential,
  createModelGateway,
  type ImageCall,
  MissingCredentialError,
  PersonLimitError,
  setPersonLimits,
  updateAgent,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/** Nano Banana 2.1 at 1K, per picture (ADR 0197's catalog). */
const BANANA = 33_600_000;

const gemini = (fx: Fixture, apiKey = "AQ.gemini-test-key-1234") =>
  createCredential(fx.db, fx.keyWrapper, fx.owner.id, fx.org.id, { provider: "gemini", label: "pictures", apiKey });

const ask = (fx: Fixture, over: Partial<ImageCall> = {}, request: Partial<ImageCall["request"]> = {}) =>
  fx.gateway.generateImages({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    personId: null,
    ...over,
    request: { model: "gemini-nano-banana-2.1", prompt: "a lighthouse at dusk", count: 1, aspect: "1:1", ...request },
  });

const imageRows = (fx: Fixture) =>
  fx.db
    .select()
    .from(schema.usageRecords)
    .where(and(eq(schema.usageRecords.orgId, fx.org.id), eq(schema.usageRecords.kind, "image")));

test("which image models a workspace can use: those whose provider has a key, its own or the platform's", async () => {
  f = await setup();
  // Only a Claude key: no pictures.
  expect(await f.gateway.availableImageModels(f.org.id)).toEqual([]);
  await gemini(f);
  const withGemini = await f.gateway.availableImageModels(f.org.id);
  expect(withGemini[0]).toBe("gemini-nano-banana-2.1");
  expect(withGemini.every((id) => id.startsWith("gemini-"))).toBe(true);
  await f.close();

  f = await setup({ platform: envPlatformCredentials({ openai: { apiKey: "sk-platform" } }) });
  const viaPlatform = await f.gateway.availableImageModels(f.org.id);
  expect(viaPlatform).toEqual(IMAGE_MODEL_IDS.filter((id) => id.startsWith("gpt-image")));
});

test("an agent's pictures: the image provider's key, never its chat key; one image row with cost, run and person", async () => {
  f = await setup();
  await gemini(f);
  const result = await ask(f, { personId: f.owner.id }, { count: 2, aspect: "16:9" });
  expect(result.images).toHaveLength(2);
  expect(result.model).toBe("gemini-nano-banana-2.1");
  expect(result.costNanoUsd).toBe(2 * BANANA);
  // The agent runs on Claude: its pictures go on the workspace's Gemini key, with the provider's own model id.
  const sent = f.provider.imageCalls.at(-1);
  expect(sent?.apiKey).toBe("AQ.gemini-test-key-1234");
  expect(sent?.request).toMatchObject({ model: "gemini-nano-banana-2.1", count: 2, aspect: "16:9", size: "1K" });
  const [row] = await imageRows(f);
  expect(row).toMatchObject({
    agentId: f.agent.id,
    personId: f.owner.id,
    provider: "gemini",
    model: "gemini-nano-banana-2.1",
    requestedModel: "gemini-nano-banana-2.1",
    costNanoUsd: 2 * BANANA,
    partial: false,
  });
  expect(row?.id).toBe(result.usageRecordId);
  // The agent's budget paid it: its counter and its month's spend both say so.
  expect((await agentBudgetState(f.db, f.org.id, f.agent.id)).spentNanoUsd).toBe(2 * BANANA);
  expect((await agentBudgetState(f.db, f.org.id, f.agent.id)).reservedNanoUsd).toBe(0);
  expect(await agentSpendThisMonth(f.db, f.org.id, f.agent.id)).toBe(2 * BANANA);
  const [month] = await f.db
    .select()
    .from(schema.personUsageMonths)
    .where(eq(schema.personUsageMonths.personId, f.owner.id));
  expect(month?.spentNanoUsd).toBe(2 * BANANA);
});

test("a budget too small for the worst case is refused before any call", async () => {
  f = await setup({ budgetNanoUsd: BANANA + 1 });
  await gemini(f);
  await expect(ask(f, {}, { count: 2 })).rejects.toBeInstanceOf(BudgetExceededError);
  expect(f.provider.imageCalls).toHaveLength(0);
  expect(await imageRows(f)).toHaveLength(0);
  // One fits.
  await ask(f);
  expect(f.provider.imageCalls).toHaveLength(1);
  // The month's first call starts from the pictures already made: the second one no longer fits.
  await f.db.delete(schema.agentBudgetPeriods).where(eq(schema.agentBudgetPeriods.agentId, f.agent.id));
  await expect(ask(f)).rejects.toBeInstanceOf(BudgetExceededError);
  expect(f.provider.imageCalls).toHaveLength(1);
});

test("crossing 80% of the budget tells the owner", async () => {
  f = await setup();
  await gemini(f);
  const events: { level: string; spentNanoUsd: number }[] = [];
  const provider = createFakeProvider();
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, provider])),
    platformCredentials: envPlatformCredentials({}),
    onBudgetThreshold: (e) => {
      events.push({ level: e.level, spentNanoUsd: e.spentNanoUsd });
    },
  });
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 120_000_000 });
  const request = { model: "gemini-nano-banana-2.1", prompt: "a fox", count: 3, aspect: "1:1" as const };
  await gateway.generateImages({ orgId: f.org.id, agentId: f.agent.id, personId: null, request });
  expect(events).toEqual([{ level: "warning", spentNanoUsd: 3 * BANANA }]);
});

test("a person's own pictures: no agent, their month added to, their limit checked first", async () => {
  f = await setup();
  await gemini(f);
  const member = await addMember(f.db, f.org.id, "member", "ada");
  const result = await ask(f, { agentId: null, personId: member.id });
  const [row] = await imageRows(f);
  expect(row).toMatchObject({ agentId: null, personId: member.id, costNanoUsd: BANANA, kind: "image" });
  expect(result.costNanoUsd).toBe(BANANA);
  const [month] = await f.db
    .select()
    .from(schema.personUsageMonths)
    .where(eq(schema.personUsageMonths.personId, member.id));
  expect(month?.spentNanoUsd).toBe(BANANA);
  // Owners have no limit (ADR 0141); a member at theirs is refused before any call.
  await setPersonLimits(f.db, f.owner.id, f.org.id, {
    default: null,
    roles: {},
    people: { [member.id]: BANANA },
    onLimit: "block",
    warn: true,
  });
  const calls = f.provider.imageCalls.length;
  await expect(ask(f, { agentId: null, personId: member.id })).rejects.toBeInstanceOf(PersonLimitError);
  expect(f.provider.imageCalls).toHaveLength(calls);
});

test("no key for the image provider, a model not in the catalog, a shape it doesn't make: refused", async () => {
  f = await setup();
  await expect(ask(f)).rejects.toBeInstanceOf(MissingCredentialError);
  await gemini(f);
  await expect(ask(f, {}, { model: "claude-sonnet-5-5" })).rejects.toBeInstanceOf(ValidationError);
  await expect(ask(f, {}, { count: 5 })).rejects.toBeInstanceOf(ValidationError);
  await expect(ask(f, {}, { size: "2K", model: "gemini-3.1-flash-lite-image" })).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(ask(f, {}, { prompt: "   " })).rejects.toBeInstanceOf(ValidationError);
  expect(f.provider.imageCalls).toHaveLength(0);
});

test("a failed call costs nothing and releases its reservation; a call that failed midway pays what it made", async () => {
  let mode: "fail" | "half" = "fail";
  f = await setup();
  await gemini(f);
  const provider = createFakeProvider(undefined, {
    image: () =>
      mode === "fail"
        ? new ProviderError("provider error AQ.gemini-test-key-1234", true, 503)
        : { count: 1, error: new ProviderError("rate limited by provider", true, 429) },
  });
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, provider])),
    platformCredentials: envPlatformCredentials({}),
  });
  const request = { model: "gemini-nano-banana-2.1", prompt: "a fox", count: 2, aspect: "1:1" as const };
  const error = await gateway
    .generateImages({ orgId: f.org.id, agentId: f.agent.id, personId: null, request })
    .catch((e: unknown) => e as ProviderError);
  expect(error).toBeInstanceOf(ProviderError);
  // Masked: the key never leaves in the words; who answered is named.
  expect((error as ProviderError).message).not.toContain("AQ.gemini-test-key-1234");
  expect((error as ProviderError).provider).toBe("Gemini");
  expect(await imageRows(f)).toHaveLength(0);
  expect(await agentBudgetState(f.db, f.org.id, f.agent.id)).toEqual({ spentNanoUsd: 0, reservedNanoUsd: 0 });

  mode = "half";
  const half = await gateway.generateImages({ orgId: f.org.id, agentId: f.agent.id, personId: null, request });
  expect(half.images).toHaveLength(1);
  expect(half.error?.status).toBe(429);
  expect(half.costNanoUsd).toBe(BANANA);
  expect((await imageRows(f)).map((r) => r.costNanoUsd)).toEqual([BANANA]);
});

test("an agent whose own key is of the image provider uses it", async () => {
  f = await setup();
  await gemini(f, "AQ.workspace-default-key");
  const own = await gemini(f, "AQ.the-agents-own-key-99");
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: own.id, model: "gemini-3.8-flash" });
  await ask(f);
  expect(f.provider.imageCalls.at(-1)?.apiKey).toBe("AQ.the-agents-own-key-99");
});
