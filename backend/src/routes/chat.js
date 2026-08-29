'use strict';
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

const SYSTEM_PROMPT = `You are the Paylode assistant, a friendly AI guide for the Paylode payment gateway platform.

Paylode is a CBN-licensed Nigerian payment gateway (PSSP) that enables businesses to accept online payments.

Key products and features:
- Payment Gateway / Checkout: Accept card and bank transfer payments from customers
- Virtual Accounts: Assign dedicated NUBAN bank accounts to customers for seamless collections
- Invoicing: Create and send payment invoices; customers pay via a generated link
- Payouts: Send money to Nigerian bank accounts instantly
- Billspay Wallet: Closed-loop member wallet for bills payment (domain: billspay.net)
- Payment Links: Shareable links to collect one-time or recurring payments without a website
- MPGS Integration: Direct Mastercard Payment Gateway Service integration for card processing

Dashboard navigation guide:
- Transactions: View, search, filter and export full payment history
- Wallet: Check merchant balance, fund wallet, initiate withdrawals to your settlement account
- Invoicing: Create invoices, send to customers, track payment status
- Payouts: Initiate bank transfers, view payout history and status
- Virtual Accounts: Create and manage dedicated customer bank accounts
- Payment Links: Create and share payment links with custom amounts
- Settings > API Keys: Get your test and live API keys for integration
- Settings > Webhooks: Configure callback URLs to receive payment event notifications
- Settings > Team: Add sub-users and manage team member access
- Onboarding: Submit CAC documents and bank details to activate your live account

Common questions and answers:
- To go live: Complete onboarding — submit CAC documents, BVN, and settlement account details
- Webhook events to expect: payment.successful, payment.failed, transfer.successful, transfer.failed
- Test environment: Use sandbox.paylodeservices.com to test integrations without real money
- Supported payment methods: Cards (Visa/Mastercard), bank transfer, USSD
- Support contact: support@paylodeservices.com

Always be concise, friendly and helpful. Focus only on Paylode-related questions. If asked about something unrelated, politely explain you can only assist with Paylode queries.`;

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

router.post('/', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ status: false, message: 'Message is required.' });
    }
    if (message.trim().length > 1000) {
      return res.status(400).json({ status: false, message: 'Message too long (max 1000 characters).' });
    }

    const safeHistory = Array.isArray(history)
      ? history.slice(-6).filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({
          role: m.role,
          content: String(m.content).slice(0, 2000),
        }))
      : [];

    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [...safeHistory, { role: 'user', content: message.trim() }],
    });

    const reply = response.content[0]?.type === 'text'
      ? response.content[0].text
      : 'Sorry, I could not generate a response. Please try again.';

    res.json({ status: true, reply });
  } catch (err) {
    console.error('[chat route]', err.message);
    res.status(500).json({ status: false, message: 'Chat is temporarily unavailable. Please try again shortly.' });
  }
});

module.exports = router;
