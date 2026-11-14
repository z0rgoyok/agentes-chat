CREATE TABLE "right_hand_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
-- deploy-safe: the index made below keeps one open handoff per agent and screen for rows without a seat, the only rows a previous version writes
DROP INDEX "browser_handoffs_one_open";--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD COLUMN "seat_user_id" text;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "right_hand_seats" ADD CONSTRAINT "right_hand_seats_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "right_hand_seats_one_live" ON "right_hand_seats" USING btree ("org_id","user_id") WHERE "right_hand_seats"."removed_at" is null;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_seat_user_id_users_id_fk" FOREIGN KEY ("seat_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_one_open_screen" ON "browser_handoffs" USING btree ("agent_id","screen",coalesce("seat_user_id", '')) WHERE "browser_handoffs"."status" in ('pending', 'active');--> statement-breakpoint
INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope")
SELECT gen_random_uuid(), a."org_id", a."id", NULL, s."scope"
FROM "agents" a CROSS JOIN (VALUES ('sandbox:run'), ('browser:use'), ('desktop:use')) AS s("scope")
WHERE a."builtin" = 'right_hand'
ON CONFLICT DO NOTHING;
