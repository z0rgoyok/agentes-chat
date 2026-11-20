ALTER TABLE "organizations" ADD COLUMN "reset_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "reset_requested_by" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_reset_requested_by_users_id_fk" FOREIGN KEY ("reset_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;