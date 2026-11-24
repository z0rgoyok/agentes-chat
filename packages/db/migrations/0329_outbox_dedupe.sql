CREATE TABLE "outbox_dedupe" (
	"dedupe_key" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox_dedupe" ADD CONSTRAINT "outbox_dedupe_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- An outbox row whose key a pruned job held is skipped, as a conflict on "dedupe_key" skips it under ON CONFLICT DO
-- NOTHING (RETURNING gives nothing), whichever statement inserts it.
CREATE FUNCTION "outbox_dedupe_refuses"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "outbox_dedupe" WHERE "dedupe_key" = NEW."dedupe_key") THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "outbox_dedupe_refuses" BEFORE INSERT ON "outbox"
  FOR EACH ROW WHEN (NEW."dedupe_key" IS NOT NULL) EXECUTE FUNCTION "outbox_dedupe_refuses"();
