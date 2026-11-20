CREATE TABLE "support_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"ref" text,
	"about_kind" text,
	"message_id" uuid,
	"text" text,
	"about" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_requests_orgId_source_ref_unique" UNIQUE("org_id","source","ref")
);
--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_requests_org_id_created_at_index" ON "support_requests" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "support_requests_user_id_index" ON "support_requests" USING btree ("user_id");