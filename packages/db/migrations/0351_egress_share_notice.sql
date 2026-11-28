-- Computers paired before agents could use a person's internet lend theirs too (ADR 0237). Where the workspace has its
-- own computer to lend to, each one's owner hears it once, with "Turn off" (`device.internet_shared`); a computer
-- marked the workspace's, or whose owner left, goes to who configures the workspace.
INSERT INTO "notifications" ("id", "org_id", "user_id", "kind", "group_key", "source", "latest")
SELECT gen_random_uuid(), d."org_id", m."user_id", 'device.internet_shared', 'device-internet:' || d."id",
  jsonb_build_object('machineId', d."id", 'label', d."name"),
  jsonb_build_object('title', d."name")
FROM "machines" d
JOIN "organization_members" m ON m."org_id" = d."org_id"
WHERE d."kind" = 'connected' AND d."deleted_at" IS NULL AND d."egress_share"
  AND EXISTS (
    SELECT 1 FROM "machines" w WHERE w."org_id" = d."org_id" AND w."kind" = 'managed' AND w."deleted_at" IS NULL
  )
  AND CASE
    WHEN NOT d."belongs_to_workspace" AND EXISTS (
      SELECT 1 FROM "organization_members" o WHERE o."org_id" = d."org_id" AND o."user_id" = d."paired_by_user_id"
    ) THEN m."user_id" = d."paired_by_user_id"
    ELSE m."role" = 'owner' OR EXISTS (
      SELECT 1 FROM "org_roles" r
      WHERE r."org_id" = m."org_id"
        AND (r."kind" = 'everyone' OR r."id" IN (
          SELECT mr."role_id" FROM "organization_member_roles" mr
          WHERE mr."org_id" = m."org_id" AND mr."user_id" = m."user_id"))
        AND r."permissions" && array['configure', 'administrator']::text[]
    )
  END
ON CONFLICT DO NOTHING;
