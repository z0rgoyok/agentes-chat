ALTER TABLE "agents" ADD COLUMN "editor_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "editor_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;