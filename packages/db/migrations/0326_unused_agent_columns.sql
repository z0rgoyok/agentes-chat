-- "brain_fallback", "brain_extra_usage" and "coordinator" leave the schema here but stay in the database: the
-- previous version still names every column of "agents" in its selects and inserts. A migration of a later release
-- drops them, once no running version has them in its schema.
-- deploy-safe: no version writes "coordinator" true since ADR 0137, so the index holds back no write
DROP INDEX IF EXISTS "agents_one_coordinator";
