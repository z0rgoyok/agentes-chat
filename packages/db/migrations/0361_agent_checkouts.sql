CREATE TABLE "agent_checkouts" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sync_started_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"credential_at" timestamp with time zone,
	CONSTRAINT "agent_checkouts_agent_id_machine_id_pk" PRIMARY KEY("agent_id","machine_id")
);
--> statement-breakpoint
ALTER TABLE "agent_checkouts" ADD CONSTRAINT "agent_checkouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_checkouts" ADD CONSTRAINT "agent_checkouts_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_checkouts" ADD CONSTRAINT "agent_checkouts_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;