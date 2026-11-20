CREATE TABLE "hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"accent" text,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosts_host" CHECK ("hosts"."host" = lower("hosts"."host") and char_length("hosts"."host") <= 253),
	CONSTRAINT "hosts_name" CHECK (char_length("hosts"."name") between 1 and 60),
	CONSTRAINT "hosts_accent" CHECK ("hosts"."accent" ~ '^#[0-9a-f]{6}$')
);
