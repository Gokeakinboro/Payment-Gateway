-- Applied 2026-06-13. SA-authored lifecycle email templates. The table/model were
-- missing (route + UI existed but no data layer). Seeds the lifecycle slugs the
-- code renders via emailService.getEmailContent(slug, vars). {{var}} = placeholder.
CREATE TABLE IF NOT EXISTS email_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL,
  name       text NOT NULL,
  subject    text NOT NULL,
  html_body  text NOT NULL,
  variables  text[] NOT NULL DEFAULT '{}',
  is_system  boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO email_templates (slug, name, subject, html_body, variables, is_system) VALUES
('application_received', 'Onboarding — Application Received',
 'Paylode application received — {{reference}}',
 '<h2>Application Received</h2><p>Dear {{name}},</p><p>Thank you for applying to join Paylode. Your application has been received and our compliance team will review it within 1-3 business days.</p><p><strong>Reference: {{reference}}</strong></p><p>Questions? Contact support@paylodeservices.com</p>',
 ARRAY['name','reference','business'], true),
('application_under_review', 'Onboarding — Under Review',
 'Your Paylode application is under review — {{reference}}',
 '<h2>Application Under Review</h2><p>Dear {{name}},</p><p>Your application ({{reference}}) for <strong>{{business}}</strong> is now under review by our compliance team. We may contact you for additional documents.</p>',
 ARRAY['name','reference','business'], true),
('application_approved', 'Onboarding — Approved',
 'Your Paylode merchant account is approved',
 '<h2>Approved</h2><p>Your application for <strong>{{business}}</strong> has been approved and your merchant account is live.</p><p>Sign in at <a href="{{login_url}}">the dashboard</a> with <strong>{{email}}</strong> and temporary password <strong>{{temp_password}}</strong> — you must change it on first sign-in.</p><p>Any outstanding KYC documents are listed in your dashboard.</p>',
 ARRAY['business','email','temp_password','login_url'], true),
('application_rejected', 'Onboarding — Rejected',
 'Update on your Paylode application — {{reference}}',
 '<h2>Application Update</h2><p>Dear {{name}},</p><p>After review, we are unable to approve your application ({{reference}}) for <strong>{{business}}</strong> at this time.</p><p>{{notes}}</p><p>You may contact support@paylodeservices.com for details.</p>',
 ARRAY['name','reference','business','notes'], true),
('temp_password', 'Account — First-time Password',
 'Your Paylode account — first-time sign-in',
 '<h2>Welcome to Paylode</h2><p>Hi {{name}},</p><p>An account has been created for you. Sign in at <a href="{{login_url}}">the portal</a> with:</p><p><strong>Email:</strong> {{email}}<br><strong>Temporary password:</strong> {{temp_password}}</p><p>For your security you must set a new password before you can do anything else.</p>',
 ARRAY['name','email','temp_password','login_url'], true),
('aggregator_welcome', 'Aggregator — Welcome',
 'Your Paylode aggregator account — first-time sign-in',
 '<h2>Welcome to Paylode</h2><p>An aggregator account for <strong>{{business}}</strong> has been created.</p><p>Sign in at <a href="{{login_url}}">the portal</a> with <strong>{{email}}</strong> and temporary password <strong>{{temp_password}}</strong>. You must change it on first sign-in.</p>',
 ARRAY['business','email','temp_password','login_url'], true)
ON CONFLICT (slug) DO NOTHING;
