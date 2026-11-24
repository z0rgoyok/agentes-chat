import { afterEach, expect, test } from "bun:test";
import type { Executor } from "@agenteschat/db";
import { forgetKnownZones, knownZoneNames } from "../src";

afterEach(forgetKnownZones);

test("the database's time zones are read once per process, and again after a read that failed", async () => {
  forgetKnownZones();
  let reads = 0;
  const db = {
    execute: async () => {
      reads++;
      if (reads === 1) throw new Error("database away");
      return [{ name: "america/sao_paulo" }, { name: "utc" }];
    },
  } as unknown as Executor;
  await expect(knownZoneNames(db)).rejects.toThrow("database away");
  expect(await knownZoneNames(db)).toEqual(["america/sao_paulo", "utc"]);
  expect(await knownZoneNames(db)).toEqual(["america/sao_paulo", "utc"]);
  expect(reads).toBe(2);
});
