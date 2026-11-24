ALTER TABLE "agent_runs" ADD COLUMN "reply_in_thread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "reply_in_threads" boolean DEFAULT false NOT NULL;