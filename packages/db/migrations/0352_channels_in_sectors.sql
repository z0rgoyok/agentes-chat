ALTER TABLE "channels" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_group_id_agent_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."agent_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Channel categories become sectors (ADR 0240). A category joins the sector of the same name, ignoring case; one with
-- no such sector becomes a new sector after the workspace's others, in the categories' order, each in the next of the
-- roles' colors so the new marks tell apart.
INSERT INTO "agent_groups" ("org_id", "name", "position", "color")
SELECT
  cc."org_id",
  cc."name",
  coalesce((SELECT max(g."position") FROM "agent_groups" g WHERE g."org_id" = cc."org_id"), -1)
    + row_number() OVER (PARTITION BY cc."org_id" ORDER BY cc."position", cc."name"),
  (ARRAY['indigo', 'violet', 'rose', 'amber', 'green', 'teal'])[
    1 + ((coalesce((SELECT count(*) FROM "agent_groups" g WHERE g."org_id" = cc."org_id"), 0)
      + row_number() OVER (PARTITION BY cc."org_id" ORDER BY cc."position", cc."name") - 1) % 6)::int
  ]
FROM "channel_categories" cc
WHERE NOT EXISTS (
  SELECT 1 FROM "agent_groups" g WHERE g."org_id" = cc."org_id" AND lower(g."name") = lower(cc."name")
);--> statement-breakpoint
-- Each category's channels move into its sector, keeping their order inside it.
UPDATE "channels" c
SET "group_id" = (
  SELECT g."id"
  FROM "channel_categories" cc
  JOIN "agent_groups" g ON g."org_id" = cc."org_id" AND lower(g."name") = lower(cc."name")
  WHERE cc."id" = c."category_id" AND cc."org_id" = c."org_id"
  ORDER BY g."position", g."created_at"
  LIMIT 1
)
WHERE c."category_id" IS NOT NULL;
