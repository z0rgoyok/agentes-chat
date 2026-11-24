ALTER TABLE "organization_settings" ADD COLUMN "plan_key_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "manage_mode" text DEFAULT 'admins' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "manage_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "manage_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "use_mode" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "use_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "use_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "reply_mode" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "reply_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "reply_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
-- "Usar em agentes" starts as "Quem usa" was: a plan that served only its owner stays theirs alone.
UPDATE "machine_accounts" SET "use_mode" = 'owner' WHERE "serves" = 'owner';--> statement-breakpoint
-- "Atender todos" starts on wherever an agent on the plan (any login of the same account) had "Atende outras pessoas"
-- on, an audience wider than its owner, so every agent answers the same people as before; the team's right hand
-- follows "Usar em agentes" instead.
UPDATE "machine_accounts" SET "reply_mode" = 'everyone'
WHERE EXISTS (
  SELECT 1 FROM "agents"
  JOIN "machine_accounts" "login" ON "login"."org_id" = "agents"."org_id" AND "login"."id" = "agents"."brain_account_id"
  WHERE "agents"."org_id" = "machine_accounts"."org_id"
    AND "agents"."archived_at" IS NULL
    AND "agents"."builtin" IS DISTINCT FROM 'right_hand'
    AND "agents"."audience_mode" <> 'owner'
    AND ("login"."id" = "machine_accounts"."id" OR (
      "login"."machine_id" = "machine_accounts"."machine_id"
      AND "login"."kind" = "machine_accounts"."kind"
      AND "login"."created_by" IS NOT DISTINCT FROM "machine_accounts"."created_by"
      AND lower("login"."email") = lower("machine_accounts"."email")))
);
