CREATE TABLE "server_processes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"rss_bytes" bigint NOT NULL,
	"heap_used_bytes" bigint NOT NULL,
	"heap_total_bytes" bigint NOT NULL,
	"event_loop_p_99_ms" real,
	"event_loop_max_ms" real,
	"heap_snapshot_at" timestamp with time zone,
	"heap_snapshot_file" text
);
