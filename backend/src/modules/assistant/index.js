'use strict';
// Paylode Portal Assistant — role-aware in-portal help bot (how to sign up / use
// and navigate the portal). Separate from the Developer Chat (API/SDK help, its
// own Next.js app). Knowledge = the curated KB below, sent as a CACHED system
// prompt. Answers portal topics only; anything else → support / Developer Chat.
const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { requireAuth } = require('../../middleware/auth');
const { ok, fail } = require('../../utils/helpers');
const { logger } = require('../../utils/logger');

const KB = fs.readFileSync(path.join(__dirname, 'portal-help-kb.md'), 'utf8');
const MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-4-6';
const KEY = process.env.ANTHROPIC_API_KEY;

const GUARD =
  'You are the Paylode Portal Assistant, a friendly in-dashboard help guide. ' +
  'Answer questions about signing up for and using/navigating the Paylode portal, ' +
  'using ONLY the knowledge base below. Be concise and practical — give step-by-step ' +
  'navigation like "go to X → Y". If a detail is marked ⟨CONFIRM⟩ or you are unsure, ' +
  'say you are not certain and suggest emailing product@paylodeservices.com rather than ' +
  'guessing. For API/SDK/integration coding questions, point users to the Developer Chat ' +
  'at /developer-chat. Politely decline anything unrelated to Paylode.';

function systemFor(audienceLine) {
  return [
    { type: 'text', text: GUARD + '\n\n=== PAYLODE PORTAL KNOWLEDGE BASE ===\n' + KB,
      cache_control: { type: 'ephemeral' } },
    { type: 'text', text: audienceLine },
  ];
}

function sanitize(body) {
  const arr = Array.isArray(body && body.messages) ? body.messages : [];
  return arr
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
}

async function askClaude(system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, system, messages }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('assistant upstream ' + r.status);
    const e = new Error(msg); e.upstream = true; throw e;
  }
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  return text || 'Sorry, I could not generate a response. Please try rephrasing.';
}

async function handle(req, res, audienceLine) {
  if (!KEY) return fail(res, 'The assistant is not configured yet.', 'ASSISTANT_OFF', 503);
  const messages = sanitize(req.body);
  if (!messages.length) return fail(res, 'A message is required');
  try {
    const reply = await askClaude(systemFor(audienceLine), messages);
    return ok(res, { reply });
  } catch (e) {
    logger.error({ err: e }, 'Portal assistant error');
    return fail(res, 'The assistant is temporarily unavailable. Please try again.', 'ASSISTANT_ERR', 502);
  }
}

// Authenticated, role-aware (merchants + staff already logged into the dashboard).
router.post('/chat', requireAuth, (req, res) => {
  const role = ((req.user && req.user.role) || 'MERCHANT').replace(/_/g, ' ').toLowerCase();
  return handle(req, res, 'The current user is a ' + role + ' using the Paylode dashboard. Tailor navigation and available features to this role.');
});

// Public (login / onboarding pages) — sign-up & general "what is this" help, no account.
router.post('/public-chat', (req, res) =>
  handle(req, res, 'The user is a prospective/new user who is NOT logged in. Focus on how to sign up, what Paylode offers, and getting started. Do not assume they have an account.'));

module.exports = router;
