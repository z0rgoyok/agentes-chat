ALTER TABLE "machines" ADD COLUMN "egress_share" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "egress_share_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "egress_via" jsonb;