-- Agents' "## Learned" sections become memory (ADR 0017 §6, amended): one job per workspace that has one. The job
-- (`memory.move_learned`, `moveLearnedSections`) needs the app's rules and search indexing; this queues it once.
-- A deploy migrates while the previous version still serves, and its workers fail a kind they have no handler for
-- for good: the job waits 30 minutes, until only versions that know it are running.
INSERT INTO "outbox" ("id", "org_id", "kind", "payload", "dedupe_key", "next_attempt_at")
SELECT gen_random_uuid(), a."org_id", 'memory.move_learned', jsonb_build_object('orgId', a."org_id"), 'memory.move_learned:' || a."org_id", now() + interval '30 minutes'
FROM (SELECT DISTINCT "org_id" FROM "agents" WHERE "deleted_at" IS NULL AND "instructions" ~ '(^|\n)##[ \t]+Learned[ \t\r]*(\n|$)') a
ON CONFLICT ("dedupe_key") DO NOTHING;
