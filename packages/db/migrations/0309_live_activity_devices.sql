CREATE TABLE "live_activity_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"install_id" text NOT NULL,
	"push_to_start_token" text,
	"activity_id" text,
	"activity_token" text,
	"widgets_dir" text NOT NULL,
	"app_id" text,
	"apns_sandbox" boolean DEFAULT false NOT NULL,
	"locale" text NOT NULL,
	"started_at" timestamp with time zone,
	"last_sent" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_activity_devices_userId_installId_unique" UNIQUE("user_id","install_id")
);
--> statement-breakpoint
ALTER TABLE "live_activity_devices" ADD CONSTRAINT "live_activity_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;