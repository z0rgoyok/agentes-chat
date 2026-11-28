-- ADR 0237 amendment 2026-11-27 c: "Use only this computer's internet", nested under the lending switch.
ALTER TABLE "machines" ADD COLUMN "egress_only" boolean DEFAULT false NOT NULL;
