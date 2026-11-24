ALTER TABLE "agents" ADD COLUMN "owner_role_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "owner_role_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_role_id_org_roles_id_fk" FOREIGN KEY ("owner_role_id") REFERENCES "public"."org_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_one_owner" CHECK ("agents"."owner_user_id" is null or "agents"."owner_role_id" is null);