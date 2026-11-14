ALTER TABLE "organization_settings" ADD COLUMN "team_watch" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "welcome_people" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_consultations_org_id_channel_id_index" ON "agent_consultations" USING btree ("org_id","channel_id");