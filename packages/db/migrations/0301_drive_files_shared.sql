-- ADR 0157, amendment 2026-11-17: a file of the Drive itself (no conversation) lives with its maker, and its sharing
-- says who else sees it, `conversation` being its maker alone. Every Drive file so far was the whole workspace's, so
-- each one says so now; new ones are made shared with everyone.
UPDATE "artifacts" SET "share" = 'everyone', "share_user_ids" = '{}'::text[], "share_role_ids" = '{}'::uuid[]
WHERE "channel_id" IS NULL AND "share" <> 'everyone';
