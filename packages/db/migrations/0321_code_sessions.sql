ALTER TYPE "public"."channel_kind" ADD VALUE 'code';--> statement-breakpoint
CREATE TABLE "code_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"root_message_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid,
	"repo" text NOT NULL,
	"repo_dir" text NOT NULL,
	"title" text NOT NULL,
	"branch" text,
	"base_branch" text,
	"base_sha" text,
	"worktree_path" text,
	"worktree_state" text DEFAULT 'preparing' NOT NULL,
	"worktree_error" text,
	"setup_command" text,
	"pr_number" integer,
	"pr_url" text,
	"files" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"stat_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "code_sessions_orgId_channelId_unique" UNIQUE("org_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_sessions_org_id_created_by_index" ON "code_sessions" USING btree ("org_id","created_by");--> statement-breakpoint
CREATE INDEX "code_sessions_org_id_repo_branch_index" ON "code_sessions" USING btree ("org_id","repo","branch");--> statement-breakpoint
CREATE INDEX "code_sessions_machine_id_index" ON "code_sessions" USING btree ("machine_id");