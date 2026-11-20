ALTER TABLE "agents" ADD COLUMN "brain_account_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "use_order" integer;