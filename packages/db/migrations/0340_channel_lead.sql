-- The agent responsible for a channel (ADR 0095, addendum of 2026-11-23): one of its member agents, or none.
ALTER TABLE "channels" ADD COLUMN "lead_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;