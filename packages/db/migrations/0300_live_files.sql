ALTER TYPE "public"."channel_kind" ADD VALUE 'file';--> statement-breakpoint
ALTER TYPE "public"."usage_kind" ADD VALUE 'image';--> statement-breakpoint
ALTER TYPE "public"."artifact_kind" ADD VALUE 'spreadsheet';--> statement-breakpoint
ALTER TYPE "public"."artifact_kind" ADD VALUE 'slides';--> statement-breakpoint
ALTER TYPE "public"."artifact_kind" ADD VALUE 'canvas';--> statement-breakpoint
CREATE TABLE "live_assets" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"storage_config_id" uuid,
	"blob_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"source" text NOT NULL,
	"origin" jsonb,
	"created_by_type" text,
	"created_by_id" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_assets_artifact_id_id_pk" PRIMARY KEY("artifact_id","id")
);
--> statement-breakpoint
CREATE TABLE "live_doc_updates" (
	"artifact_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"update" text NOT NULL,
	"bytes" integer NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_doc_updates_artifact_id_seq_pk" PRIMARY KEY("artifact_id","seq")
);
--> statement-breakpoint
CREATE TABLE "live_docs" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"state_bytes" integer DEFAULT 0 NOT NULL,
	"head_seq" bigint DEFAULT 0 NOT NULL,
	"compacted_seq" bigint DEFAULT 0 NOT NULL,
	"preview" jsonb,
	"edited_at" timestamp with time zone,
	"edited_by_type" text,
	"edited_by_id" text,
	"edited_run_id" uuid,
	"checkpoint_at" timestamp with time zone,
	"checkpoint_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_image_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text,
	"run_id" uuid,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"aspect" text DEFAULT '1:1' NOT NULL,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shape_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frame_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "conversation_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "conversation_root_id" uuid;--> statement-breakpoint
ALTER TABLE "live_assets" ADD CONSTRAINT "live_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_assets" ADD CONSTRAINT "live_assets_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_doc_updates" ADD CONSTRAINT "live_doc_updates_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_doc_updates" ADD CONSTRAINT "live_doc_updates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_docs" ADD CONSTRAINT "live_docs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_docs" ADD CONSTRAINT "live_docs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_image_requests" ADD CONSTRAINT "live_image_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_image_requests" ADD CONSTRAINT "live_image_requests_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_assets_org_id_index" ON "live_assets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "live_doc_updates_org_id_index" ON "live_doc_updates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "live_docs_org_id_index" ON "live_docs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "live_image_requests_org_id_requested_by_id_created_at_index" ON "live_image_requests" USING btree ("org_id","requested_by_id","created_at");--> statement-breakpoint
CREATE INDEX "live_image_requests_artifact_id_index" ON "live_image_requests" USING btree ("artifact_id");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_conversation_channel_id_channels_id_fk" FOREIGN KEY ("conversation_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_conversation_channel_id_index" ON "artifacts" USING btree ("conversation_channel_id");