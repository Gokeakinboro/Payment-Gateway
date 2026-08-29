'use strict';
const PDFDocument = require('/opt/paylode-api/backend/node_modules/pdfkit');
const fs = require('fs');

const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
doc.pipe(fs.createWriteStream('/tmp/Paylode-Tech-Doc.pdf'));

const NAVY = '#1a1a2e';
const BLUE = '#0078D4';
const GRAY = '#666666';
const PAGE_BOTTOM = 750;

function checkPage(needed) {
  if (doc.y + (needed || 20) > PAGE_BOTTOM) {
    doc.addPage();
  }
}

function sectionHead(title) {
  checkPage(40);
  doc.moveDown(0.5);
  doc.rect(50, doc.y, 495, 22).fill(BLUE);
  const ty = doc.y - 17;
  doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(title, 58, ty, { width: 480 });
  doc.fillColor('black').moveDown(0.3);
}

function subHead(title) {
  checkPage(30);
  doc.moveDown(0.4);
  doc.fillColor(NAVY).fontSize(9.5).font('Helvetica-Bold').text(title);
  doc.moveDown(0.2);
}

function body(text) {
  checkPage(30);
  doc.fillColor('#333333').fontSize(8.5).font('Helvetica').text(text, { lineGap: 2, width: 495 });
  doc.moveDown(0.3);
}

function table(headers, rows) {
  const colWidth = Math.floor(495 / headers.length);
  const startX = 50;

  checkPage(20 + rows.length * 16);

  // If still not enough space after check, add page
  if (doc.y + 20 + rows.length * 16 > PAGE_BOTTOM) {
    doc.addPage();
  }

  let y = doc.y;

  // Header
  doc.rect(startX, y, 495, 18).fill('#d0e4f7');
  headers.forEach((h, i) => {
    doc.fillColor(NAVY).fontSize(7.5).font('Helvetica-Bold')
      .text(h, startX + i * colWidth + 3, y + 5, { width: colWidth - 6 });
  });
  y += 18;

  rows.forEach((row, ri) => {
    // Check if row would overflow
    if (y + 16 > PAGE_BOTTOM) {
      doc.addPage();
      y = doc.y;
      // Redraw header
      doc.rect(startX, y, 495, 18).fill('#d0e4f7');
      headers.forEach((h, i) => {
        doc.fillColor(NAVY).fontSize(7.5).font('Helvetica-Bold')
          .text(h, startX + i * colWidth + 3, y + 5, { width: colWidth - 6 });
      });
      y += 18;
    }

    if (ri % 2 === 0) doc.rect(startX, y, 495, 16).fill('#f8f9ff');
    else doc.rect(startX, y, 495, 16).fill('white');

    row.forEach((cell, i) => {
      doc.fillColor('#333').fontSize(7.5).font('Helvetica')
        .text(String(cell || ''), startX + i * colWidth + 3, y + 4, { width: colWidth - 6 });
    });
    y += 16;
  });

  doc.y = y + 6;
  doc.moveDown(0.2);
}

// ═══════════════════════════════════
// COVER PAGE
// ═══════════════════════════════════
doc.rect(0, 0, 595, 250).fill(NAVY);
doc.fillColor('white').fontSize(32).font('Helvetica-Bold').text('PAYLODE', 50, 70);
doc.fontSize(16).font('Helvetica').text('Payment Gateway', 50, 115);
doc.moveDown(0.3);
doc.fontSize(11).text('Technology & Architecture Document', 50, 140);
doc.rect(0, 250, 595, 5).fill(BLUE);

doc.fillColor(GRAY).fontSize(9).font('Helvetica')
  .text('Paylode Services  |  CBN-Licensed PSSP  |  August 2026', 50, 268);
doc.moveDown(0.3);
doc.rect(50, doc.y, 495, 1).fill('#cccccc');
doc.moveDown(0.5);
doc.fillColor('#cc0000').fontSize(9).font('Helvetica-Bold')
  .text('CONFIDENTIAL — For Investor Review Only');

// Summary boxes on cover
doc.moveDown(1.5);
const boxY = doc.y;
const boxes = [
  { label: 'CBN Licensed', sub: 'PSSP' },
  { label: 'Node.js 20 LTS', sub: 'Backend Runtime' },
  { label: 'PostgreSQL 16', sub: '67 Tables' },
  { label: '6 vCPU / 12GB', sub: 'Server Specs' },
];
boxes.forEach((b, i) => {
  const bx = 50 + i * 125;
  doc.rect(bx, boxY, 115, 55).fill('#0f3460').stroke();
  doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(b.label, bx + 5, boxY + 10, { width: 105, align: 'center' });
  doc.fillColor('#aaccff').fontSize(8).font('Helvetica').text(b.sub, bx + 5, boxY + 28, { width: 105, align: 'center' });
});

doc.addPage();

// ═══════════════════════════════════
// SECTION 1: EXECUTIVE SUMMARY
// ═══════════════════════════════════
sectionHead('1. EXECUTIVE SUMMARY');
body('Paylode is a Central Bank of Nigeria (CBN)-licensed Payment Service Solution Provider (PSSP) built on a proprietary technology stack designed for reliability, security, and extensibility. The platform processes payments across multiple rails, issues virtual accounts, supports invoicing, handles payouts, and provides a closed-loop wallet product (Billspay). All infrastructure is owned and operated by Paylode Services, with zero dependence on third-party payment platforms for core processing.');

// ═══════════════════════════════════
// SECTION 2: BUSINESS PRODUCTS
// ═══════════════════════════════════
sectionHead('2. BUSINESS PRODUCTS');
table(['Product', 'Description'], [
  ['Payment Gateway / Checkout', 'Hosted checkout, inline embed, and API integration for Nigerian merchants'],
  ['Virtual Accounts (VA)', 'Merchant-issued unique virtual bank accounts via Parallex Bank integration'],
  ['Invoicing', 'Full invoicing module with contacts, QR-code payments, and series management'],
  ['Payouts', 'Bulk and single payouts to Nigerian bank accounts across all major banks (30+)'],
  ['Billspay Wallet', 'Closed-loop member wallet with transfers, airtime, data, and bills payment'],
  ['MPGS Portal', 'Mastercard Payment Gateway Services merchant onboarding and card acceptance'],
  ['AI Assistant', 'Embedded Claude AI assistant for merchants and internal operations'],
]);

// ═══════════════════════════════════
// SECTION 3: INFRASTRUCTURE
// ═══════════════════════════════════
sectionHead('3. INFRASTRUCTURE & HARDWARE');

subHead('3.1 Primary Production Server');
table(['Component', 'Specification'], [
  ['Provider', 'Contabo Cloud VPS — EU Data Centre, Germany'],
  ['Plan', 'Cloud VPS 20 SSD'],
  ['CPU', '6 vCPU cores'],
  ['RAM', '12 GB DDR4'],
  ['Storage', '200 GB NVMe SSD (13 GB used / 181 GB free — 7%)'],
  ['Operating System', 'Ubuntu 24.04 LTS (Noble Numbat)'],
  ['Kernel', 'Linux 6.8.0-137-generic x86_64'],
  ['Public IP', '176.57.188.45 (IPv4) + 2a02:c207:2333:0325::1 (IPv6)'],
  ['Uptime SLA', 'Contabo 99.9% SLA'],
]);

subHead('3.2 Secondary / Redundancy Server');
table(['Component', 'Specification'], [
  ['IP', '45.141.122.223'],
  ['Role', 'Frontend serving, live DNS failover target, hot standby'],
  ['Provider', 'Independent provider (non-Contabo) for hardware diversity'],
]);

subHead('3.3 CDN & DNS');
table(['Component', 'Provider / Detail'], [
  ['DNS & CDN', 'Cloudflare — Global edge network, DDoS protection, WAF'],
  ['Primary Domain', 'paylodeservices.com / www.paylodeservices.com'],
  ['API Domain', 'api.paylodeservices.com'],
  ['MPGS Domain', 'mpgs.paylodeservices.com'],
  ['Wallet Domain', 'billspay.net'],
  ['Marketplace', 'themarket.paylodeservices.com'],
]);

// ═══════════════════════════════════
// SECTION 4: TECHNOLOGY STACK
// ═══════════════════════════════════
sectionHead('4. TECHNOLOGY STACK');

subHead('4.1 Backend');
table(['Layer', 'Technology', 'Version'], [
  ['Runtime', 'Node.js', 'v20.20.2 LTS'],
  ['Framework', 'Express.js', '^4.x'],
  ['ORM', 'Prisma', '^5.x'],
  ['Process Manager', 'PM2 (cluster mode)', 'v7.x'],
  ['Package Manager', 'npm', '10.8.2'],
]);

subHead('4.2 Data Layer');
table(['Component', 'Technology', 'Version'], [
  ['Primary Database', 'PostgreSQL', '16.14'],
  ['Cache / Session Store', 'Redis', '7.0.15'],
  ['Job Queue', 'BullMQ (Redis-backed)', '^5.x'],
]);

subHead('4.3 Web Server & Networking');
table(['Component', 'Technology', 'Version / Detail'], [
  ['Reverse Proxy', 'Nginx', '1.24.0'],
  ['SSL/TLS', "Let's Encrypt (Certbot)", 'Auto-renewing, 90-day cycle'],
  ['TLS Protocol', 'TLS 1.2 minimum / TLS 1.3 preferred', '—'],
  ['VPN Client', 'Libreswan (IPSec IKEv2)', '4.14'],
  ['Firewall', 'UFW — deny-all inbound by default', '—'],
]);

subHead('4.4 Frontend');
table(['Layer', 'Technology'], [
  ['Stack', 'Vanilla HTML5, CSS3, JavaScript (ES2020+)'],
  ['Serving', 'Nginx static file serving from /var/www/paylode'],
  ['CI/CD', 'GitHub Actions — auto-deploy on push to main branch'],
]);

subHead('4.5 Key Libraries & Dependencies');
table(['Package', 'Purpose'], [
  ['@prisma/client', 'Type-safe database ORM and query builder'],
  ['bcryptjs', 'Password and PIN hashing (cost factor 10)'],
  ['bullmq', 'Distributed job queue for webhooks and async workers'],
  ['cloudinary', 'KYC document and media storage'],
  ['express-rate-limit', 'API rate limiting per route'],
  ['express-validator', 'Request input validation'],
  ['helmet', 'HTTP security headers (HSTS, CSP, X-Frame-Options)'],
  ['jsonwebtoken', 'JWT authentication tokens'],
  ['nodemailer', 'Transactional email delivery'],
  ['otplib', 'TOTP/OTP generation for 2FA'],
  ['pdf-lib / pdfkit', 'PDF generation for receipts, statements, invoices'],
  ['pino', 'High-performance structured JSON logging'],
  ['qrcode', 'QR code generation for invoices and payment links'],
  ['web-push', 'Real-time push notifications to merchants'],
  ['xlsx', 'Excel report generation for settlements and reconciliation'],
]);

// ═══════════════════════════════════
// SECTION 5: ARCHITECTURE
// ═══════════════════════════════════
sectionHead('5. SYSTEM ARCHITECTURE');

subHead('5.1 Architecture Pattern');
body('The backend is architected as a modular monolith — a single deployable unit with clearly separated, independently deployable modules. This delivers the operational simplicity of a monolith with the separation-of-concerns of microservices. Each module owns its routes, services, and database tables. Any module can be extracted into a standalone microservice with minimal refactoring as traffic demands grow.');

subHead('5.2 Running Services');
table(['Service', 'Mode', 'Description'], [
  ['paylode-core', 'Cluster x2 workers', 'Core gateway: transactions, merchants, checkout, KYC, payouts, rails, admin'],
  ['paylode-invoicing', 'Fork', 'Full invoicing module with QR code payments and contacts'],
  ['paylode-invoicing-worker', 'Fork', 'Background invoice processing and PDF generation queue'],
  ['paylode-wallet', 'Fork', 'Billspay closed-loop member wallet'],
  ['paylode-webhook-worker', 'Fork', 'Webhook delivery engine with BullMQ retry logic'],
  ['paylode-assistant', 'Fork', 'AI-powered merchant assistant (Anthropic Claude API)'],
  ['da-backend', 'Fork', 'DrinksArena marketplace backend'],
  ['golf-platform', 'Cluster x2', 'Golf Platform service'],
]);

subHead('5.3 Database — 67 Tables');
table(['Domain', 'Key Tables'], [
  ['Core Entities', 'merchants, users, api_keys, transactions, audit_log'],
  ['KYC & Compliance', 'kyc_submissions, kyc_documents, kyc_verification_reports, aml_flags, compliance_watchlist'],
  ['Invoicing (12 tables)', 'inv_invoices, inv_contacts, inv_products, inv_qr_codes, inv_invoice_payments'],
  ['Wallet / Billspay', 'mw_wallets, mw_ledger, mw_members, mw_dept_ledger, merchant_wallets'],
  ['Payouts & Settlements', 'payout_batches, payout_items, settlements, agg_payouts, rail_disbursements'],
  ['MPGS Cards', 'mpgs_applications, mpgs_applicants, mpgs_documents, merchant_mpgs_configs'],
  ['Virtual Accounts', 'merchant_virtual_accounts'],
  ['Webhooks & Messaging', 'webhook_deliveries, whatsapp_message_log'],
  ['Config & Rates', 'platform_settings, platform_rate_configs, merchant_rate_configs, nigerian_banks'],
  ['Onboarding', 'onboarding_submissions, onboarding_invite_events, document_deferrals'],
]);

// ═══════════════════════════════════
// SECTION 6: SECURITY
// ═══════════════════════════════════
sectionHead('6. SECURITY ARCHITECTURE');

subHead('6.1 Authentication & Authorization');
table(['Layer', 'Implementation'], [
  ['Merchant API Auth', 'HMAC-SHA256 signed API keys (separate test + live key pairs)'],
  ['Dashboard Auth', 'JWT (JSON Web Tokens) with role-based access control'],
  ['User Roles', 'Super Admin, Admin, Compliance Officer, Aggregator, Merchant'],
  ['PIN / Password', 'bcrypt hashing (cost factor 10) — all secrets hashed at rest, never stored plain'],
  ['2FA / OTP', '6-digit TOTP for two-factor authentication and new device verification'],
  ['Session', 'Token-based with configurable expiry; device fingerprinting for new device OTP'],
]);

subHead('6.2 Transport Security');
table(['Component', 'Standard'], [
  ['TLS', 'TLS 1.2 minimum, TLS 1.3 preferred across all endpoints'],
  ['Certificate Authority', "Let's Encrypt — auto-renewing 90-day certificates on all domains"],
  ['Security Headers', 'Helmet.js: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy'],
  ['CDN / WAF', 'Cloudflare WAF with DDoS mitigation, bot management, and rate limiting at edge'],
  ['Firewall', 'UFW: deny-all inbound by default; PostgreSQL accessible only from whitelisted IPs'],
  ['VPN', 'Libreswan IPSec IKEv2 (AES-256/SHA-256/DH Group 14) for all bank integrations'],
]);

subHead('6.3 Application Security');
table(['Control', 'Implementation'], [
  ['Rate Limiting', 'express-rate-limit: per-route limits on all public API endpoints'],
  ['Input Validation', 'express-validator: schema-based validation on every request'],
  ['SQL Injection', 'Prisma parameterised queries — zero raw SQL in business logic'],
  ['Webhook Verification', 'HMAC-SHA256 signature validation on all inbound webhooks (Youverify, Meta, Palmpay)'],
  ['Audit Logging', 'All privileged actions logged to audit_log with actor, IP, timestamp, and payload'],
  ['CORS', 'Strict origin whitelist — no wildcard CORS on authenticated routes'],
]);

subHead('6.4 KYC & Biometric Security');
table(['Check', 'Provider / Standard'], [
  ['BVN Verification', 'Youverify — real-time NIBSS-backed bank verification number check'],
  ['NIN Verification', 'Youverify — NIMC national identity database'],
  ['CAC Verification', 'Youverify — Corporate Affairs Commission company registry'],
  ['Liveness / Biometric', 'Youverify facial liveness detection — webcam selfie captured at onboarding'],
  ['AML Screening', 'Youverify — PEP + global sanctions screening (OFAC, UN, EU)'],
  ['Adverse Media', 'Youverify adverse media intelligence screening'],
  ['Biometric Retention', 'Selfies persisted to encrypted server storage — retrievable for law enforcement'],
  ['Document Integrity', 'CAC cert OCR via Claude vision API — RC number and entity type auto-verified'],
]);

// ═══════════════════════════════════
// SECTION 7: PAYMENT RAILS
// ═══════════════════════════════════
sectionHead('7. PAYMENT RAILS & INTEGRATIONS');

subHead('7.1 Active Payment Rails');
table(['Rail', 'Type', 'Purpose'], [
  ['Parallex Bank', 'Virtual Account issuance', 'Merchant VA provisioning and inbound collections'],
  ['MPGS (Mastercard)', 'Card payment gateway', 'Card acceptance: Mastercard, Visa for checkout'],
  ['Nigerian Banks (30+)', 'Bank transfer / direct debit', 'Payout disbursement to all major Nigerian banks'],
]);

subHead('7.2 Third-Party Service Integrations');
table(['Service', 'Provider', 'Purpose'], [
  ['KYC / Identity', 'Youverify', 'BVN, NIN, CAC, liveness, AML, adverse media — full KYC suite'],
  ['WhatsApp Messaging', 'Meta WhatsApp Cloud API', 'Transaction receipts, payment links, QR code sharing'],
  ['Email', 'SMTP / Nodemailer', 'Transactional email: receipts, KYC status, merchant notifications'],
  ['Document Storage', 'Cloudinary', 'KYC document uploads and secure retrieval'],
  ['AI / OCR', 'Anthropic Claude API', 'Merchant assistant, CAC cert OCR, internal tools'],
  ['Push Notifications', 'Web Push API', 'Real-time browser push alerts to merchants'],
]);

subHead('7.3 Bank VPN Architecture');
body("All bank API integrations use dedicated IPSec site-to-site VPN tunnels. Each tunnel uses IKEv2 with AES-256 encryption, SHA-256 integrity, and DH Group 14 key exchange — providing a private encrypted channel between Paylode infrastructure and the bank's internal network. This architecture mirrors the same setup used successfully with Airtel Nigeria for USSD services (tunnel active, passing live traffic).");

// ═══════════════════════════════════
// SECTION 8: DEVOPS
// ═══════════════════════════════════
sectionHead('8. DEVOPS & DEPLOYMENT');
table(['Component', 'Tool / Approach'], [
  ['Source Control', 'GitHub — private repositories under DigitalMarketingLimited organisation'],
  ['CI/CD', 'GitHub Actions — auto-deploy frontend on every push to main branch'],
  ['Backend Deploy', 'SCP + PM2 cluster reload — zero-downtime deploys (at least 1 worker always live)'],
  ['Process Management', 'PM2 — auto-restart on crash, startup persistence, cluster scaling'],
  ['Monitoring', 'Paylode Guardian — custom synthetic monitoring; alerts to product@paylodeservices.com'],
  ['Smoke Testing', 'Daily automated smoke tests against all live API endpoints'],
  ['Backup', 'Contabo Auto Backup — daily provider-managed server snapshots'],
  ['Dead-letter', 'Failed submissions written to disk — no silent data loss on onboarding'],
  ['Log Management', 'Pino structured JSON logging, PM2 log rotation'],
]);

// ═══════════════════════════════════
// SECTION 9: SCALABILITY
// ═══════════════════════════════════
sectionHead('9. SCALABILITY & GROWTH PATH');

subHead('Current Headroom');
table(['Resource', 'In Use', 'Total Capacity', 'Headroom'], [
  ['RAM', '1.2 GB', '12 GB', '~8-10x current load before upgrade needed'],
  ['Disk', '13 GB', '200 GB', '93% free — years of growth runway'],
  ['CPU', '6 vCPU', '6 vCPU', 'Significant headroom at current transaction volume'],
]);

subHead('Scaling Strategy');
table(['Stage', 'Approach'], [
  ['Immediate', 'PM2 cluster — add CPU workers with zero code change'],
  ['Database', 'PostgreSQL read replicas + PgBouncer connection pooling'],
  ['Microservices', 'Each PM2 service already independently deployable — extract on demand'],
  ['Multi-region', 'Cloudflare geo-routing + database replication to second region'],
  ['Queue scaling', 'BullMQ + Redis already handles all async workloads; add workers per queue'],
]);

// ═══════════════════════════════════
// SECTION 10: COMPLIANCE
// ═══════════════════════════════════
sectionHead('10. COMPLIANCE & LICENSING');
table(['Item', 'Status / Detail'], [
  ['CBN Licence', 'PSSP Licence — Paylode Services'],
  ['KYC Framework', '3-tier KYC: BVN + NIN + CAC + liveness biometric capture'],
  ['AML Screening', 'Real-time PEP + global sanctions screening on every merchant application'],
  ['Adverse Media', 'Automated adverse media intelligence on all onboarding applicants'],
  ['Biometric Retention', 'Selfies stored on encrypted server disk — retrievable for law enforcement on request'],
  ['Document Retention', 'All KYC documents retained with full audit trail'],
  ['Data Residency', 'Primary data stored in EU (Germany, Contabo)'],
  ['Webhook Security', 'HMAC-SHA256 signed webhooks — replay attack prevention'],
  ['Mastercard Compliance', 'MPGS portal with dedicated compliance exception tracking table'],
  ['Audit Trail', 'Immutable audit_log: every privileged action with actor, IP, and timestamp'],
]);

// ═══════════════════════════════════
// SECTION 11: SUMMARY
// ═══════════════════════════════════
sectionHead('11. PLATFORM SUMMARY');
table(['Metric', 'Value'], [
  ['Company', 'Paylode Services'],
  ['Product', 'Paylode (paylodeservices.com)'],
  ['Licence', 'CBN PSSP'],
  ['Backend Language', 'JavaScript — Node.js v20.20.2 LTS'],
  ['Frontend', 'Vanilla HTML5 / CSS3 / ES2020+'],
  ['Primary Database', 'PostgreSQL 16.14 with Prisma ORM'],
  ['Database Tables', '67 tables across all product domains'],
  ['Running Services', '11 PM2-managed processes'],
  ['Backend Modules', '4 core modules: gateway-core, invoicing, wallet, assistant'],
  ['Active SSL Domains', '6 domains with auto-renewing certificates'],
  ['Test Environment', 'Full sandbox with separate test API keys'],
  ['Uptime Monitoring', 'Paylode Guardian + daily smoke tests'],
  ['GitHub Repos', 'Payment-Gateway, cdl-ussd, DRINKSAREMA, themarket, LSSB'],
  ['Technical Contact', 'Goke Akinboro — gokeakinboro@gmail.com'],
]);

// Footer on last page
doc.moveDown(1.5);
checkPage(30);
doc.rect(50, doc.y, 495, 1).fill('#cccccc');
doc.moveDown(0.3);
doc.fillColor(GRAY).fontSize(7.5).font('Helvetica')
  .text('Paylode | Paylode Services | CONFIDENTIAL — For Investor Review | August 2026', { align: 'center' });

doc.end();
console.log('PDF done');
