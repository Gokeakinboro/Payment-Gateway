-- Allow SYSTEM-initiated audit events (no human actor) to be recorded.
-- Previously audit_log.actor_id was NOT NULL with a required FK to users, so any
-- system event (e.g. a rail low-balance incident) failed the insert and was lost.
ALTER TABLE audit_log ALTER COLUMN actor_id DROP NOT NULL;
