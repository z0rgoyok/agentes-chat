import { describe, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type { ApiClient, OrgSettings } from "../src/index";
import { keys, settingsWith, updateSettingsMutation } from "../src/index";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const SETTINGS: OrgSettings = {
  name: "Acme",
  context: "",
  defaultCredentialId: null,
  routerModel: null,
  summaryModel: null,
  timezone: "UTC",
  actionCheck: true,
  autoModels: {},
  gifs: true,
  gifRating: "g",
  agentStickers: true,
  agentMedia: "sometimes",
  voiceMessages: true,
  voiceAvailable: false,
  gifsAvailable: false,
  agentMediaAvailable: false,
};

/** `orgs.updateSettings` answers each call when the test says, in the order they were made. */
function setup() {
  const qc = new QueryClient();
  qc.setQueryData(keys.settings("o1"), SETTINGS);
  const answers: ReturnType<typeof deferred<OrgSettings>>[] = [];
  const api = {
    orgs: {
      updateSettings: () => {
        const answer = deferred<OrgSettings>();
        answers.push(answer);
        return answer.promise;
      },
      settings: async () => SETTINGS,
    },
  } as unknown as ApiClient;
  const save = (input: Parameters<ApiClient["orgs"]["updateSettings"]>[1]) =>
    new MutationObserver(qc, updateSettingsMutation(api, qc, "o1")).mutate(input);
  const shown = () => qc.getQueryData<OrgSettings>(keys.settings("o1"));
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { answers, save, shown, tick };
}

describe("the workspace's settings save as they change", () => {
  test("a switch moves as it is tapped, before the server answers, and the answer then stands", async () => {
    const s = setup();
    const done = s.save({ actionCheck: false });
    await s.tick();
    expect(s.shown()?.actionCheck).toBe(false);
    s.answers[0]?.resolve({ ...SETTINGS, actionCheck: false });
    await done;
    expect(s.shown()?.actionCheck).toBe(false);
  });

  test("a refusal puts back what was there", async () => {
    const s = setup();
    const done = s.save({ gifs: false });
    await s.tick();
    expect(s.shown()?.gifs).toBe(false);
    s.answers[0]?.reject(new Error("refused"));
    await expect(done).rejects.toThrow("refused");
    expect(s.shown()?.gifs).toBe(true);
  });

  test("two in flight: the first answer never flicks the second change back, and the last answer stands", async () => {
    const s = setup();
    const first = s.save({ gifs: false });
    await s.tick();
    const second = s.save({ agentStickers: false });
    await s.tick();
    expect([s.shown()?.gifs, s.shown()?.agentStickers]).toEqual([false, false]);
    // The server's answer to the first knows nothing of the second yet.
    s.answers[0]?.resolve({ ...SETTINGS, gifs: false });
    await first;
    expect([s.shown()?.gifs, s.shown()?.agentStickers]).toEqual([false, false]);
    s.answers[1]?.resolve({ ...SETTINGS, gifs: false, agentStickers: false });
    await second;
    expect(s.shown()).toEqual({ ...SETTINGS, gifs: false, agentStickers: false });
  });

  test("a change is shown as the server will answer it: a model of null puts its tier back on the default", () => {
    const saved = { ...SETTINGS, autoModels: { openrouter: { small: "a/s", large: "a/l" } } };
    expect(settingsWith(saved, { timezone: "America/Sao_Paulo", gifRating: "pg" })).toEqual({
      ...saved,
      timezone: "America/Sao_Paulo",
      gifRating: "pg",
    });
    expect(settingsWith(saved, { autoModels: { openrouter: { small: null, medium: "a/m" } } }).autoModels).toEqual({
      openrouter: { large: "a/l", medium: "a/m" },
    });
  });

  test("the context waits for the server: the first run moves on only once it is saved", async () => {
    expect(settingsWith(SETTINGS, { context: "Our team", gifs: false })).toEqual({ ...SETTINGS, gifs: false });
    const s = setup();
    const done = s.save({ context: "Our team" });
    await s.tick();
    expect(s.shown()?.context).toBe("");
    s.answers[0]?.resolve({ ...SETTINGS, context: "Our team" });
    await done;
    expect(s.shown()?.context).toBe("Our team");
  });
});
