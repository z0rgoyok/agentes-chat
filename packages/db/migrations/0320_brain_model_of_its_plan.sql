-- Codex, the Antigravity CLI and Grok Build run only their own maker's models, but a settings card could store
-- another maker's ("claude-opus-5-5" on Codex), which no run of theirs can use. Each such agent goes back to the model
-- it had before that change (its latest `agent.brain` audit entry that set it), or to its CLI's default when that one
-- is another maker's too or there is none.
WITH "bad" AS (
  SELECT "id", "org_id", "brain", "brain_model" FROM "agents"
  WHERE ("brain" = 'codex' AND "brain_model" ~* '^(claude-|gemini-|grok-|(fable|opus|sonnet|haiku)$)')
     OR ("brain" = 'antigravity' AND "brain_model" ~* '^(claude-|gpt-|o[0-9]|grok-|(fable|opus|sonnet|haiku)$)')
     OR ("brain" = 'grok' AND "brain_model" ~* '^(claude-|gpt-|o[0-9]|gemini-|(fable|opus|sonnet|haiku)$)')
),
"before" AS (
  SELECT DISTINCT ON ("bad"."id") "bad"."id", "audit_log"."details" -> 'from' ->> 'model' AS "model"
  FROM "bad"
  JOIN "audit_log" ON "audit_log"."org_id" = "bad"."org_id"
    AND "audit_log"."action" = 'agent.brain'
    AND "audit_log"."target_id" = "bad"."id"::text
    AND "audit_log"."details" -> 'to' ->> 'model' = "bad"."brain_model"
    AND "audit_log"."details" -> 'from' ->> 'brain' = "bad"."brain"
  ORDER BY "bad"."id", "audit_log"."created_at" DESC
),
"next" AS (
  SELECT "bad"."id", CASE
      WHEN "bad"."brain" = 'codex' AND "before"."model" ~* '^(claude-|gemini-|grok-|(fable|opus|sonnet|haiku)$)' THEN NULL
      WHEN "bad"."brain" = 'antigravity' AND "before"."model" ~* '^(claude-|gpt-|o[0-9]|grok-|(fable|opus|sonnet|haiku)$)' THEN NULL
      WHEN "bad"."brain" = 'grok' AND "before"."model" ~* '^(claude-|gpt-|o[0-9]|gemini-|(fable|opus|sonnet|haiku)$)' THEN NULL
      ELSE "before"."model"
    END AS "model"
  FROM "bad" LEFT JOIN "before" ON "before"."id" = "bad"."id"
)
UPDATE "agents" SET "brain_model" = "next"."model", "updated_at" = now()
FROM "next"
WHERE "agents"."id" = "next"."id";
