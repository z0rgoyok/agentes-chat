CREATE TABLE "issue_assignees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"assignee_type" text NOT NULL,
	"assignee_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_assignees_issueId_assigneeType_assigneeId_unique" UNIQUE("issue_id","assignee_type","assignee_id")
);
--> statement-breakpoint
ALTER TABLE "issue_assignees" ADD CONSTRAINT "issue_assignees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_assignees" ADD CONSTRAINT "issue_assignees_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_assignees_org_id_assignee_type_assignee_id_index" ON "issue_assignees" USING btree ("org_id","assignee_type","assignee_id");--> statement-breakpoint
-- Each task keeps who had it, as the first of its list. An archived agent or a person who left the workspace is on
-- no task from now on, so neither is carried over.
INSERT INTO "issue_assignees" ("org_id", "issue_id", "assignee_type", "assignee_id", "position")
SELECT i."org_id", i."id", i."assignee_type", i."assignee_id", 0
FROM "issues" i
WHERE i."assignee_id" IS NOT NULL
	AND ((i."assignee_type" = 'agent' AND EXISTS (SELECT 1 FROM "agents" a
			WHERE a."id"::text = i."assignee_id" AND a."org_id" = i."org_id" AND a."archived_at" IS NULL))
		OR (i."assignee_type" = 'person' AND EXISTS (SELECT 1 FROM "organization_members" m
			WHERE m."user_id" = i."assignee_id" AND m."org_id" = i."org_id")));
