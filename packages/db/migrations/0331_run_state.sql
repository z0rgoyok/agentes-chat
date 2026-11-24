ALTER TABLE "agent_runs" ADD COLUMN "state" jsonb;--> statement-breakpoint
-- The transcript's keys "state" copies (`RUN_STATE_KEYS` in the engine): present ones only, as they are, so a read of
-- one there answers what the same read of the transcript does.
CREATE FUNCTION "agent_runs_state_of"(t jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, t -> k), '{}'::jsonb)
  FROM unnest(ARRAY['waitingForBrain', 'outage', 'roomAsk', 'roomPeople', 'roomAsked', 'roomOrderSince', 'roomWaitSince',
    'signInWait', 'spill', 'accountMove', 'usageWait', 'usagePause', 'usageGrant', 'catchUp', 'catchUpTriage', 'steeredBy',
    'answerOwed', 'passListed', 'requestMoot', 'promptKey', 'toolGroups', 'autoModel']) AS k
  WHERE t ? k
$$;--> statement-breakpoint
-- Whichever statement writes the transcript, a version of the server that knows nothing of "state" included.
CREATE FUNCTION "agent_runs_state"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."state" := "agent_runs_state_of"(NEW."transcript");
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_runs_state" BEFORE INSERT OR UPDATE OF "transcript" ON "agent_runs"
  FOR EACH ROW EXECUTE FUNCTION "agent_runs_state"();--> statement-breakpoint
-- The runs not ended yet, a few hundred at most, found on the (org_id, status) index. An ended run keeps a null
-- "state": its reads fall back to its transcript (`runState`), as no single UPDATE should decompress them all.
UPDATE "agent_runs" SET "state" = "agent_runs_state_of"("transcript")
WHERE "status" IN ('queued', 'running', 'waiting_approval', 'waiting_input');
