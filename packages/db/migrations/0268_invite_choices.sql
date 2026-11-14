ALTER TABLE "organization_invitations" ADD COLUMN "agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invite_links" ADD COLUMN "role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invite_links" ADD COLUMN "channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invite_links" ADD COLUMN "agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invite_links" ADD COLUMN "max_uses" integer;--> statement-breakpoint
ALTER TABLE "organization_invite_links" ADD COLUMN "plain" boolean DEFAULT true NOT NULL;