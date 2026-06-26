-- Onboarding lifecycle redesign (2026-06-18): approval no longer auto-activates —
-- the merchant self-activates. Rejection now carries a missing-items checklist.
-- Update the DB-stored templates so they match the new flow (these OVERRIDE the
-- inline fallbacks in the code).
--
-- RUN AS THE APP USER (paylode):
--   PGPASSWORD=PaylodeSecure2025 psql -h 127.0.0.1 -U paylode -d paylode_db -f this.sql

-- Approved → tell them to ACTIVATE (not "your account is live").
UPDATE email_templates SET
  subject = 'Your Paylode application is approved — activate to go live',
  html_body =
    '<h2>Approved &#127881;</h2>' ||
    '<p>Your application for <strong>{{business}}</strong> has been approved. One step remains before your account goes live and your <strong>live</strong> API keys start working — <strong>activate your account</strong>:</p>' ||
    '<ol>' ||
      '<li>Sign in to <a href="{{login_url}}">your dashboard</a> ({{email}}).</li>' ||
      '<li>Click the <strong>Activate Account</strong> button shown on your dashboard.</li>' ||
      '<li>Accept the go-live terms and confirm your settlement bank account.</li>' ||
      '<li>Your account goes live immediately — switch your test keys to live (Dashboard &rarr; API Keys).</li>' ||
    '</ol>' ||
    '<p>Until you activate, your test/sandbox access keeps working as before.</p>',
  variables = ARRAY['business','email','temp_password','login_url'],
  updated_at = now()
WHERE slug = 'application_approved';

-- Rejected → list the reviewer notes + the missing-items checklist; point to My Application.
UPDATE email_templates SET
  subject = 'Action needed on your Paylode application — {{reference}}',
  html_body =
    '<h2>Action needed on your application</h2>' ||
    '<p>Dear {{name}},</p>' ||
    '<p>We reviewed your application ({{reference}}) for <strong>{{business}}</strong> and need a few corrections before we can approve it.</p>' ||
    '<p><strong>Reviewer notes:</strong> {{notes}}</p>' ||
    '{{missing_items_html}}' ||
    '<p>Please sign in to <a href="{{login_url}}">your dashboard</a>, open <strong>My Application</strong>, make the corrections and resubmit — we''ll review again right away.</p>',
  variables = ARRAY['name','reference','business','notes','missing_items_html','login_url'],
  updated_at = now()
WHERE slug = 'application_rejected';
