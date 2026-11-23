CREATE TABLE "surface_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"code" text,
	"link_id" uuid,
	"user_id" text,
	"org_id" uuid,
	"external_hash" text
);
--> statement-breakpoint
CREATE TABLE "surface_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"link_id" uuid,
	"kind" text NOT NULL,
	"message_id" uuid,
	"message_created_at" timestamp with time zone,
	"in_reply_to" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "surface_deliveries_kind" CHECK ("surface_deliveries"."kind" in ('reply', 'linked')),
	CONSTRAINT "surface_deliveries_outcome" CHECK ("surface_deliveries"."outcome" in ('sent', 'unsent', 'fallback', 'dropped'))
);
--> statement-breakpoint
CREATE TABLE "surface_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"surface" text NOT NULL,
	"external_id" text NOT NULL,
	"display" text,
	"profile_name" text,
	"status" text NOT NULL,
	"org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "surface_links_status" CHECK ("surface_links"."status" in ('pending', 'active'))
);
--> statement-breakpoint
ALTER TABLE "voice_clips" ADD COLUMN "via" jsonb;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_link_id_surface_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."surface_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_links" ADD CONSTRAINT "surface_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_links" ADD CONSTRAINT "surface_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "surface_calls_at_index" ON "surface_calls" USING btree ("at");--> statement-breakpoint
CREATE INDEX "surface_deliveries_open" ON "surface_deliveries" USING btree ("created_at") WHERE "surface_deliveries"."taken_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_deliveries_one_per_reply" ON "surface_deliveries" USING btree ("message_id") WHERE "surface_deliveries"."kind" = 'reply';--> statement-breakpoint
CREATE UNIQUE INDEX "surface_links_one_per_sender" ON "surface_links" USING btree ("surface","external_id") WHERE "surface_links"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "surface_links_one_per_account" ON "surface_links" USING btree ("user_id","surface") WHERE "surface_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "surface_links_user_id_index" ON "surface_links" USING btree ("user_id");