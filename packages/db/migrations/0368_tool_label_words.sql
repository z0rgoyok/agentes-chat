-- A connector tool's name in a person's language, written once per workspace and language (the work lines in a conversation).
CREATE TABLE "tool_label_words" (
	"org_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"key" text NOT NULL,
	"words" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_label_words_org_id_locale_key_pk" PRIMARY KEY("org_id","locale","key")
);
--> statement-breakpoint
ALTER TABLE "tool_label_words" ADD CONSTRAINT "tool_label_words_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;