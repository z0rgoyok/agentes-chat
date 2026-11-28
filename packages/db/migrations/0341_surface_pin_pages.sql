CREATE TABLE "surface_page_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"browser_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	CONSTRAINT "surface_page_links_kind" CHECK ("surface_page_links"."kind" in ('confirm', 'screen', 'control'))
);
--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "pin_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_links" ADD COLUMN "pin_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surface_page_links" ADD CONSTRAINT "surface_page_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_page_links" ADD CONSTRAINT "surface_page_links_link_id_surface_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."surface_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_page_links" ADD CONSTRAINT "surface_page_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_page_links_token_hash_index" ON "surface_page_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "surface_page_links_link_id_index" ON "surface_page_links" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "surface_page_links_created_at_index" ON "surface_page_links" USING btree ("created_at");