-- A job due now wakes every process's outbox worker when its transaction commits, instead of waiting for their next
-- poll (up to a second): NOTIFY is delivered at commit, once per transaction however many rows. This covers jobs queued
-- inside other jobs (an agent's run asking another agent, a router's pick) and jobs a stopping worker hands back.
-- Mirrors the Postgres pub/sub's channel and envelope (`PG_CHANNEL`, `publish` in packages/adapters/src/pubsub.ts)
-- and the workers' wake topic (`WAKE_TOPIC` in apps/server/src/workers.ts).
CREATE FUNCTION "outbox_wake"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('agenteschat_events', '{"t":"system:outbox-wake","e":{"type":"wake"}}');
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "outbox_wake" AFTER INSERT OR UPDATE OF "next_attempt_at" ON "outbox"
  FOR EACH ROW WHEN (NEW."status" = 'pending' AND NEW."next_attempt_at" <= clock_timestamp() + interval '2 seconds')
  EXECUTE FUNCTION "outbox_wake"();
