ALTER TYPE "public"."proposal_status" ADD VALUE 'undone';--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "decided_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "review" text;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "undone_by_user_id" text;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD CONSTRAINT "context_proposals_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD CONSTRAINT "context_proposals_undone_by_user_id_users_id_fk" FOREIGN KEY ("undone_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;