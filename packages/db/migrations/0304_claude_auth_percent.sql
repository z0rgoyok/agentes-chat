-- deploy-safe: the same check comes back below, wider (it also takes 'percent'); running code writes only 'selected' or 'all'
ALTER TABLE "claude_auth_settings" DROP CONSTRAINT "claude_auth_settings_rollout";--> statement-breakpoint
ALTER TABLE "claude_auth_settings" ADD COLUMN "percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_telemetry" ADD COLUMN "router_plan_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_auth_settings" ADD CONSTRAINT "claude_auth_settings_percent" CHECK ("claude_auth_settings"."percent" between 0 and 100);--> statement-breakpoint
ALTER TABLE "claude_auth_settings" ADD CONSTRAINT "claude_auth_settings_rollout" CHECK ("claude_auth_settings"."rollout" in ('selected', 'percent', 'all'));--> statement-breakpoint
INSERT INTO "instance_telemetry" ("id", "router_plan_fallback") SELECT 1, true WHERE EXISTS (SELECT 1 FROM "organizations") ON CONFLICT ("id") DO UPDATE SET "router_plan_fallback" = true;
