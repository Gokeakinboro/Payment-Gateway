-- Track which reminder_days have been fired per club invoice (prevents duplicate sends).
CREATE TABLE IF NOT EXISTS club_invoice_reminders (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid        NOT NULL REFERENCES inv_invoices(id) ON DELETE CASCADE,
  reminder_day integer    NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT club_invoice_reminders_invoice_day_unique UNIQUE (invoice_id, reminder_day)
);
CREATE INDEX IF NOT EXISTS idx_club_invoice_reminders_invoice ON club_invoice_reminders(invoice_id);
