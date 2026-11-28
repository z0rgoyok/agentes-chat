-- NOT VALID: every row before this holds the old rule, which the new one only widens, so no partition is scanned
-- (a scan of every month of messages under an exclusive lock). New rows are checked.
-- deploy-safe: the same constraint is added back at once, wider; the running version writes only rows it allows
ALTER TABLE "messages" DROP CONSTRAINT "messages_author";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author" CHECK (("author_type" = 'person' and "author_agent_id" is null) or ("author_type" = 'agent' and "author_user_id" is null) or ("author_type" = 'app' and "author_user_id" is null and "author_agent_id" is null)) NOT VALID;
