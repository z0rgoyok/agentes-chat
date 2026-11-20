ALTER TABLE "agent_consultations" ADD COLUMN IF NOT EXISTS "for_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_consultations" ADD COLUMN IF NOT EXISTS "asker_read_outside" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_consultations_handed_for_idx" ON "agent_consultations" USING btree ("org_id","target_agent_id","for_user_id","created_at");