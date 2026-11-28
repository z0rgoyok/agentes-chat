ALTER TYPE "public"."author_type" ADD VALUE 'app';--> statement-breakpoint
CREATE TABLE "integration_app_channels" (
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"can_post" boolean DEFAULT false NOT NULL,
	CONSTRAINT "integration_app_channels_app_id_channel_id_pk" PRIMARY KEY("app_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "integration_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'graphite' NOT NULL,
	"token_hash" text,
	"token_hint" text,
	"token_created_at" timestamp with time zone,
	"webhook_url" text,
	"webhook_secret_ciphertext" text,
	"webhook_wrapped_data_key" text,
	"webhook_kek_id" text,
	"webhook_last_at" timestamp with time zone,
	"webhook_last_error" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "integration_apps_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "integration_apps_name" CHECK (char_length("integration_apps"."name") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "integration_app_channels" ADD CONSTRAINT "integration_app_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_app_channels" ADD CONSTRAINT "integration_app_channels_app_id_integration_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."integration_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_app_channels" ADD CONSTRAINT "integration_app_channels_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_apps" ADD CONSTRAINT "integration_apps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_apps" ADD CONSTRAINT "integration_apps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_app_channels_channel_id_index" ON "integration_app_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "integration_apps_org_id_index" ON "integration_apps" USING btree ("org_id");