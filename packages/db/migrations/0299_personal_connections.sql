-- ADR 0099 addendum: a connection is the team's or one person's, as the Vault's items are (ADR 0144). One live
-- connection per catalog connector for the team and one for each person; an OAuth state remembers a personal sign-in.
-- deploy-safe: existing rows stay the team's (null owner), the previous version writes no owner, and the new index keeps
-- its rows unique per connector as the old one did. The previous version reads no owner either, so it would treat a
-- personal row as the team's: before it serves again, revoke personal rows (ADR 0099 addendum, "Rolling back").
DROP INDEX "connector_connections_one_active";--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_one_active" ON "connector_connections" USING btree ("org_id","connector",coalesce("owner_user_id", '')) WHERE "connector_connections"."revoked_at" is null;