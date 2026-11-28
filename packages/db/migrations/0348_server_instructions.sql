ALTER TABLE "connector_connections" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "use_instructions" boolean DEFAULT true NOT NULL;