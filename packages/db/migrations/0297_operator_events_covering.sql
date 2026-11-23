CREATE INDEX IF NOT EXISTS "operator_events_created_at_type_org" ON "operator_events" USING btree ("created_at","type","org_id");--> statement-breakpoint
CREATE STATISTICS IF NOT EXISTS "operator_events_day_type_org" (ndistinct) ON (("created_at" at time zone 'utc')::date), "type", "org_id" FROM "operator_events";--> statement-breakpoint
ANALYZE "operator_events";
