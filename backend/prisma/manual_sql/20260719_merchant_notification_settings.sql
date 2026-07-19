-- Add notification_settings JSON column to merchants
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS notification_settings JSONB NOT NULL DEFAULT '{}';
