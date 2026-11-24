CREATE TABLE "telegram_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"update_id" bigint,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"chat_title" text,
	"sender_name" text,
	"sender_id" text,
	"message_id" bigint,
	"text" text,
	"kind" text NOT NULL,
	"status" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_updates_connectionId_updateId_unique" UNIQUE("connection_id","update_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_connection_id_connector_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connector_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_updates_connection_id_chat_id_received_at_index" ON "telegram_updates" USING btree ("connection_id","chat_id","received_at");--> statement-breakpoint
CREATE INDEX "telegram_updates_received_at_index" ON "telegram_updates" USING btree ("received_at");