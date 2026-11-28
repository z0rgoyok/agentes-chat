-- Channel sections become each person's own (ADR 0260). A workspace whose sectors hold channels chose to group them:
-- everyone in it starts with one section per such sector, the sector's name and order, its channels in their order.
-- Only the channels the person sees: the public ones and the private ones they are in. A person whose view already has
-- sections keeps them. Sectors stay as they are, on Equipe › Setores.
UPDATE "organization_members" m
SET "sidebar_items" = m."sidebar_items" || jsonb_build_object(
  'view', coalesce(m."sidebar_items" -> 'view', '{}'::jsonb) || jsonb_build_object('sections', s."sections")
)
FROM (
  SELECT om."org_id", om."user_id",
    jsonb_agg(
      jsonb_build_object('id', g."id"::text, 'name', left(btrim(g."name"), 40), 'channelIds', g."channel_ids")
      ORDER BY g."position", g."created_at"
    ) AS "sections"
  FROM "organization_members" om
  JOIN LATERAL (
    SELECT ag."id", ag."name", ag."position", ag."created_at",
      (
        SELECT jsonb_agg(c."id"::text ORDER BY c."position", c."name")
        FROM "channels" c
        WHERE c."group_id" = ag."id" AND c."kind" = 'channel' AND c."archived_at" IS NULL AND c."deleted_at" IS NULL
          AND (
            c."visibility" = 'public'
            OR EXISTS (
              SELECT 1 FROM "channel_members" cm WHERE cm."channel_id" = c."id" AND cm."user_id" = om."user_id"
            )
          )
      ) AS "channel_ids"
    FROM "agent_groups" ag
    WHERE ag."org_id" = om."org_id" AND btrim(ag."name") <> ''
  ) g ON g."channel_ids" IS NOT NULL
  GROUP BY om."org_id", om."user_id"
) s
WHERE m."org_id" = s."org_id" AND m."user_id" = s."user_id"
  AND (m."sidebar_items" -> 'view' -> 'sections') IS NULL;
