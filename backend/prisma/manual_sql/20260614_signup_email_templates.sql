-- Applied 2026-06-14. Extra lifecycle templates for application-time key issuance.
INSERT INTO email_templates (slug, name, subject, html_body, variables, is_system) VALUES
('sandbox_welcome', 'Signup — Sandbox Access Ready',
 'Your Paylode sandbox access is ready',
 '<h2>Start building now</h2><p>While we review your application, your <strong>test / sandbox</strong> access is ready. Sign in at <a href="{{login_url}}">the dashboard</a> with <strong>{{email}}</strong> and temporary password <strong>{{temp_password}}</strong> (you will set a new one on first login).</p><p>Go to <strong>Dashboard &rarr; API Keys</strong> to copy your sk_test / pk_test keys and test every product in our sandbox. Your <strong>live</strong> keys activate automatically once your KYC is approved.</p>',
 ARRAY['business','email','temp_password','login_url'], true),
('application_approved_live', 'Onboarding — Approved (live keys active)',
 'Your Paylode merchant account is approved',
 '<h2>Approved</h2><p>Your application for <strong>{{business}}</strong> has been approved &mdash; your <strong>live</strong> API keys are now active.</p><p>Sign in to your <a href="{{login_url}}">dashboard</a> and switch from your test keys to your live keys (Dashboard &rarr; API Keys).</p><p>Any outstanding KYC documents are listed in your dashboard.</p>',
 ARRAY['business','login_url'], true)
ON CONFLICT (slug) DO NOTHING;
