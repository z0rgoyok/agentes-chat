ALTER TABLE "artifacts" ADD COLUMN "editors_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "editor_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "editor_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "conversation_edits" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "agent_base" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "agent_view_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "agent_edit_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;