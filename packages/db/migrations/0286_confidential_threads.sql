CREATE TABLE "confidential_threads" (
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"root_message_id" uuid NOT NULL,
	"connection_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confidential_threads_org_id_root_message_id_pk" PRIMARY KEY("org_id","root_message_id")
);
--> statement-breakpoint
ALTER TABLE "confidential_threads" ADD CONSTRAINT "confidential_threads_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "confidential_threads_marked_at_index" ON "confidential_threads" USING btree ("marked_at");