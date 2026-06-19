-- migration_v8.sql
-- Adds Twilio deadline reminder consent and tracking columns
-- Run once on the production Supabase instance before deploying deadline-cron.js

-- Student opts in to receive voice + WhatsApp reminder calls from IBHighway
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS call_consent BOOLEAN NOT NULL DEFAULT FALSE;

-- Prevent double-calling: track whether a milestone has already been reminded
ALTER TABLE deadline_milestones
  ADD COLUMN IF NOT EXISTS reminder_called    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reminder_called_at TIMESTAMPTZ;

-- Index for the daily cron query (milestones due in 3 days, not yet reminded)
CREATE INDEX IF NOT EXISTS idx_milestones_reminder
  ON deadline_milestones (due_date, is_completed, reminder_called);
