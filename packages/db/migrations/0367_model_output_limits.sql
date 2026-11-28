-- What a workspace key may make a model write, learned from its provider (a restart asks again only past a month).
CREATE TABLE "model_output_limits" (
	"org_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"model" text NOT NULL,
	"max_output_tokens" integer,
	"learned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_output_limits_credential_id_model_pk" PRIMARY KEY("credential_id","model")
);
--> statement-breakpoint
ALTER TABLE "model_output_limits" ADD CONSTRAINT "model_output_limits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_output_limits" ADD CONSTRAINT "model_output_limits_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_output_limits_org_id_index" ON "model_output_limits" USING btree ("org_id");