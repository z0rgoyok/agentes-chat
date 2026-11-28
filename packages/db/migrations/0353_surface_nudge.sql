-- deploy-safe: the check comes back at once below with one more kind, so every row any version writes still passes
ALTER TABLE "surface_deliveries" DROP CONSTRAINT "surface_deliveries_kind";--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "nudge_on" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "nudge_after_hours" smallint DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "quiet_from" smallint DEFAULT 22 NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "quiet_to" smallint DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_kind" CHECK ("surface_deliveries"."kind" in ('reply', 'linked', 'nudge'));--> statement-breakpoint
ALTER TABLE "surface_links" ADD CONSTRAINT "surface_links_nudge" CHECK ("surface_links"."nudge_after_hours" between 1 and 24 and "surface_links"."quiet_from" between 0 and 23 and "surface_links"."quiet_to" between 0 and 23);