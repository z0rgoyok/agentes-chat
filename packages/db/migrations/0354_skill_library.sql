CREATE TABLE "skill_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"channel_id" uuid,
	"thread_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "learns_skills" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "skill_suggestions" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "described_hash" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "title_by_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_uses" ADD CONSTRAINT "skill_uses_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_uses_org_id_skill_id_created_at_index" ON "skill_uses" USING btree ("org_id","skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_uses_org_id_agent_id_created_at_index" ON "skill_uses" USING btree ("org_id","agent_id","created_at");