'use strict';
const PDFDocument = require('/opt/paylode-api/backend/node_modules/pdfkit');
const fs = require('fs');

const doc = new PDFDocument({ margin: 50, size: 'A4' });
doc.pipe(fs.createWriteStream('/tmp/Paylode-Technology-Architecture.pdf'));

// Colors
const NAVY = '#1a1a2e';
const BLUE = '#0078D4';
const GRAY = '#666666';
const LIGHT = '#f5f5f5';

// Helper: section heading
function sectionHead(title) {
  doc.moveDown(0.8);
  doc.rect(50, doc.y, 495, 22).fill(BLUE);
  doc.fillColor('white').fontSize(11).font('Helvetica-Bold').text(title, 58, doc.y - 17);
  doc.fillColor('black').moveDown(0.6);
}

// Helper: subsection heading
function subHead(title) {
  doc.moveDown(0.5);
  doc.fillColor(NAVY).fontSize(10).font('Helvetica-Bold').text(title);
  doc.moveDown(0.2);
}

// Helper: body text
function body(text) {
  doc.fillColor('#333333').fontSize(9).font('Helvetica').text(text, { lineGap: 2 });
  doc.moveDown(0.2);
}

// Helper: table
function table(headers, rows) {
  const colWidth = 495 / headers.length;
  const startX = 50;
  let y = doc.y;

  // Header row
  doc.rect(startX, y, 495, 18).fill('#e8f0fe');
  headers.forEach((h, i) => {
    doc.fillColor(NAVY).fontSize(8).font('Helvetica-Bold').text(h, startX + i * colWidth + 4, y + 5, { width: colWidth - 8 });
  });
  y += 18;

  // Data rows
  rows.forEach((row, ri) => {
    const rowH = 16;
    if (ri % 2 === 0) doc.rect(startX, y, 495, rowH).fill('#fafafa');
    row.forEach((cell, i) => {
      doc.fillColor('#333').fontSize(8).font('Helvetica').text(String(cell), startX + i * colWidth + 4, y + 4, { width: colWidth - 8 });
    });
    y += rowH;
  });
  doc.y = y + 4;
  doc.moveDown(0.3);
}

// ══════════════════════════════════════════════════════
// COVER PAGE
// ══════════════════════════════════════════════════════
doc.rect(0, 0, 595, 200).fill(NAVY);
doc.fillColor('white').fontSize(26).font('Helvetica-Bold').text('PAYLODE', 50, 60);
doc.fontSize(14).font('Helvetica').text('Payment Gateway', 50, 95);
doc.fontSize(10).text('Technology & Architecture Document', 50, 118);
doc.rect(0, 200, 595, 4).fill(BLUE);

doc.fillColor(GRAY).fontSize(9).font('Helvetica')
  .text('EagleCrest Premium Services Ltd  |  CBN-Licensed PSSP  |  August 2026', 50, 215);
doc.moveDown(0.5);
doc.fillColor('#cc0000').fontSize(9).font('Helvetica-Bold')
  .text('CONFIDENTIAL — For Investor Review Only', 50, doc.y);

doc.moveDown(2);

// ══════════════════════════════════════════════════════
// 1. EXECUTIVE SUMMARY
// ══════════════════════════════════════════════════════
sectionHead('1. EXECUTIVE SUMMARY');
body('Paylode is a Central Bank of Nigeria (CBN)-licensed Payment Service Solution Provider (PSSP) built on a proprietary technology stack designed for reliability, security, and extensibility. The platform processes payments across multiple rails, issues virtual accounts, supports invoicing, handles payouts, and provides a closed-loop wallet product (Billspay). All infrastructure is owned and operated by EagleCrest Premium Services Ltd.');

// ══════════════════════════════════════════════════════
// 2. BUSINESS PRODUCTS
// ══════════════════════════════════════════════════════
sectionHead('2. BUSINESS PRODUCTS');
table(['Product', 'Description'], [
  ['Payment Gateway / Checkout', 'Hosted checkout, inline embed, and API integration for Nigerian merchants'],
  ['Virtual Accounts (VA)', 'Merchant-issued unique virtual bank accounts via Parallex Bank integration'],
  ['Invoicing', 'Full invoicing module with contacts, QR-code payments, and series management'],
  ['Payouts', 'Bulk and single payouts to Nigerian bank accounts across all major banks'],
  ['Billspay Wallet', 'Closed-loop member wallet with transfers, airtime, data, and bills payment'],
  ['MPGS Portal', 'Mastercard Payment Gateway Services merchant onboarding and card acceptance'],
  ['AI Assistant', 'Embedded Claude AI assistant for merchants and internal operations'],
]);

// ══════════════════════════════════════════════════════
// 3. INFRASTRUCTURE & HARDWARE
// ══════════════════════════════════════════════════════
sectionHead('3. INFRASTRUCTURE & HARDWARE');

subHead('3.1 Primary Production Server');
table(['Component', 'Specification'], [
  ['Provider', 'Contabo Cloud VPS — EU Data Centre, Germany'],
  ['CPU', '6 vCPU cores'],
  ['RAM', '12 GB DDR4'],
  ['Storage', '200 GB NVMe SSD (13 GB used / 181 GB available — 7%)'],
  ['Operating System', 'Ubuntu 24.04 LTS (Noble Numbat)'],
  ['Kernel', 'Linux 6.8.0-137-generic x86_64'],
  ['Public IP', '176.57.188.45'],
  ['Uptime SLA', 'Contabo 99.9% SLA'],
]);

subHead('3.2 Secondary / Redundancy Server');
table(['Component', 'Specification'], [
  ['IP', '45.141.122.223'],
  ['Role', 'Frontend serving, CDN edge, live DNS failover target'],
  ['Provider', 'Independent provider (non-Contabo) for hardware diversity'],
]);

subHead('3.3 CDN & DNS');
table(['Component', 'Provider'], [
  ['DNS & CDN', 'Cloudflare — Global edge network, DDoS protection, WAF'],
  ['Primary Domain', 'paylodeservices.com'],
  ['API Domain', 'api.paylodeservices.com'],
  ['MPGS Domain', 'mpgs.paylodeservices.com'],
  ['Wallet', 'billspay.net'],
]);

// ══════════════════════════════════════════════════════
// 4. TECHNOLOGY STACK
// ══════════════════════════════════════════════════════
sectionHead('4. TECHNOLOGY STACK');

subHead('4.1 Backend Runtime & Framework');
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
  ['Cache / Session', 'Redis', '7.0.15'],
  ['Job Queue', 'BullMQ (Redis-backed)', '^5.x'],
]);

subHead('4.3 Web Server & Networking');
table(['Component', 'Technology', 'Version'], [
  ['Reverse Proxy', 'Nginx', '1.24.0'],
  ['SSL/TLS', "Let's Encrypt (Certbot)", 'Auto-renew'],
  ['TLS Version', 'TLS 1.2 / TLS 1.3', '—'],
  ['VPN', 'Libreswan (IPSec IKEv2)', '4.14'],
  ['Firewall', 'UFW (Uncomplicated Firewall)', '—'],
]);

subHead('4.4 Frontend');
table(['Layer', 'Technology'], [
  ['Stack', 'Vanilla HTML5, CSS3, JavaScript (ES2020+)'],
  ['Serving', 'Nginx static file serving from /var/www/paylode'],
  ['Deployment', 'GitHub Actions CI/CD (auto-deploy on push to main)'],
]);

// ══════════════════════════════════════════════════════
// 5. SYSTEM ARCHITECTURE
// ══════════════════════════════════════════════════════
sectionHead('5. SYSTEM ARCHITECTURE');

subHead('5.1 Architecture Pattern: Modular Monolith');
body("The backend is architected as a modular monolith — a single deployable unit with clearly separated, independently deployable modules. This delivers operational simplicity while allowing individual modules to be extracted into standalone microservices as scale demands. Each module owns its routes, services, and database tables.");

subHead('5.2 Running Services (PM2)');
table(['Service', 'Mode', 'Description'], [
  ['paylode-core', 'Cluster x2', 'Core gateway: transactions, checkout, KYC, payouts, rails, admin'],
  ['paylode-invoicing', 'Fork', 'Full invoicing module with QR payments'],
  ['paylode-invoicing-worker', 'Fork', 'Background invoice processing queue'],
  ['paylode-wallet', 'Fork', 'Billspay closed-loop wallet'],
  ['paylode-webhook-worker', 'Fork', 'Webhook delivery with retry via BullMQ'],
  ['paylode-assistant', 'Fork', 'AI-powered merchant assistant (Claude API)'],
]);

subHead('5.3 Database — 67 Tables');
table(['Domain', 'Tables (examples)'], [
  ['Core', 'merchants, users, api_keys, transactions, audit_log'],
  ['KYC & Compliance', 'kyc_submissions, kyc_documents, kyc_verification_reports, aml_flags'],
  ['Invoicing', 'inv_invoices, inv_contacts, inv_products, inv_qr_codes (12 tables)'],
  ['Wallet / Billspay', 'mw_wallets, mw_ledger, mw_members, merchant_wallets, wallet_ledger'],
  ['Payouts & Settlements', 'payout_batches, payout_items, settlements, agg_payouts'],
  ['MPGS', 'mpgs_applications, mpgs_applicants, merchant_mpgs_configs'],
  ['Virtual Accounts', 'merchant_virtual_accounts'],
  ['Webhooks', 'webhook_deliveries, whatsapp_message_log'],
  ['Config & Rates', 'platform_settings, platform_rate_configs, merchant_rate_configs'],
  ['Onboarding', 'onboarding_submissions, onboarding_invite_events, document_deferrals'],
]);

// ══════════════════════════════════════════════════════
// 6. SECURITY ARCHITECTURE
// ══════════════════════════════════════════════════════
sectionHead('6. SECURITY ARCHITECTURE');

subHead('6.1 Authentication & Authorization');
table(['Layer', 'Implementation'], [
  ['Merchant API Auth', 'HMAC-SHA256 signed API keys (test + live environments)'],
  ['Dashboard Auth', 'JWT (JSON Web Tokens) with role-based access control'],
  ['Roles', 'Super Admin, Admin, Compliance, Aggregator, Merchant'],
  ['PIN / Password hashing', 'bcrypt (cost factor 10) — all secrets hashed at rest'],
  ['OTP / 2FA', '6-digit TOTP for two-factor authentication and device verification'],
]);

subHead('6.2 Transport & Network Security');
table(['Component', 'Standard'], [
  ['TLS', 'TLS 1.2 minimum, TLS 1.3 preferred on all endpoints'],
  ['Certificate Authority', "Let's Encrypt (auto-renewing, 90-day cycle)"],
  ['HTTP Security Headers', 'Helmet.js: HSTS, CSP, X-Frame-Options, X-Content-Type-Options'],
  ['CDN Protection', 'Cloudflare WAF, DDoS mitigation, bot management'],
  ['Firewall', 'UFW — deny-all inbound by default; whitelist-only outbound DB access'],
  ['VPN', 'Libreswan IPSec IKEv2 (AES-256/SHA-256/DH-14) for bank integrations'],
]);

subHead('6.3 Application Security');
table(['Control', 'Implementation'], [
  ['Rate Limiting', 'Per-route limits via express-rate-limit'],
  ['Input Validation', 'express-validator on all API endpoints'],
  ['SQL Injection', 'Prisma parameterised queries — no raw SQL in business logic'],
  ['Webhook Security', 'HMAC-SHA256 signature verification on all inbound webhooks'],
  ['Audit Logging', 'All privileged operations logged with actor, IP, and timestamp'],
]);

subHead('6.4 KYC & Biometric Security');
table(['Check', 'Provider / Standard'], [
  ['BVN Verification', 'Youverify — real-time NIBSS-backed verification'],
  ['NIN Verification', 'Youverify — NIMC national database'],
  ['CAC Verification', 'Youverify — Corporate Affairs Commission registry'],
  ['Liveness / Biometric', 'Youverify facial liveness detection with selfie capture'],
  ['AML Screening', 'Youverify PEP + global sanctions database'],
  ['Adverse Media', 'Youverify adverse media intelligence'],
  ['Biometric Retention', 'Selfies persisted to encrypted server storage for law enforcement'],
  ['Document Storage', 'All KYC documents stored server-side with secure path references'],
]);

// ══════════════════════════════════════════════════════
// 7. PAYMENT RAILS & INTEGRATIONS
// ══════════════════════════════════════════════════════
sectionHead('7. PAYMENT RAILS & INTEGRATIONS');

subHead('7.1 Active Payment Rails');
table(['Rail', 'Type', 'Purpose'], [
  ['Parallex Bank', 'Virtual Account issuance', 'Merchant VA provisioning and collections'],
  ['MPGS (Mastercard)', 'Card payment gateway', 'Card acceptance (Mastercard, Visa) for checkout'],
  ['Nigerian Banks (30+)', 'Direct bank transfer', 'Payout disbursement to all Nigerian banks'],
]);

subHead('7.2 Third-Party Integrations');
table(['Service', 'Provider', 'Purpose'], [
  ['KYC / Identity', 'Youverify', 'BVN, NIN, CAC, liveness, AML, adverse media'],
  ['WhatsApp Messaging', 'Meta WhatsApp Cloud API', 'Receipts, payment links, QR codes'],
  ['Email', 'SMTP / Nodemailer', 'Transactional email, KYC notifications'],
  ['Document Storage', 'Cloudinary', 'KYC document uploads and management'],
  ['AI / Assistant', 'Anthropic Claude API', 'Merchant assistant, OCR, internal tools'],
  ['Push Notifications', 'Web Push API', 'Real-time merchant alerts'],
]);

subHead('7.3 Bank VPN Integration');
body("All bank API integrations use dedicated IPSec site-to-site VPN tunnels (IKEv2, AES-256, SHA-256, DH Group 14), providing a private encrypted channel between Paylode's server and the bank's internal network. This mirrors the same architecture used successfully with Airtel Nigeria for USSD services.");

// ══════════════════════════════════════════════════════
// 8. DEVOPS & DEPLOYMENT
// ══════════════════════════════════════════════════════
sectionHead('8. DEVOPS & DEPLOYMENT');
table(['Component', 'Tool'], [
  ['Source Control', 'GitHub (private repositories under DigitalMarketingLimited org)'],
  ['CI/CD', 'GitHub Actions — auto-deploy frontend on push to main'],
  ['Backend Deploy', 'SCP + PM2 reload (zero-downtime cluster reload)'],
  ['Process Management', 'PM2 — auto-restart, startup persistence, cluster mode'],
  ['Monitoring', 'Paylode Guardian — custom synthetic monitoring + email alerts'],
  ['Smoke Tests', 'Daily automated tests against all live API endpoints'],
  ['Server Backup', 'Contabo Auto Backup — daily provider-managed snapshots'],
  ['Dead-letter Queue', 'Failed submissions written to disk — never silently lost'],
]);

// ══════════════════════════════════════════════════════
// 9. SCALABILITY
// ══════════════════════════════════════════════════════
sectionHead('9. SCALABILITY & GROWTH PATH');

subHead('Current Capacity Headroom');
table(['Metric', 'Current', 'Capacity'], [
  ['RAM', '1.2 GB used', '12 GB total — 8-10x growth headroom'],
  ['Disk', '13 GB used', '200 GB total — 7% utilized'],
  ['CPU', '6 vCPU', 'Significant headroom at current transaction volume'],
  ['DB connections', 'Prisma pooled', 'PgBouncer-ready for connection pooling at scale'],
]);

subHead('Scaling Strategy');
table(['Stage', 'Approach'], [
  ['Horizontal scaling', 'PM2 cluster mode — add workers with zero code changes'],
  ['Database scaling', 'PostgreSQL read replicas + PgBouncer connection pooling'],
  ['Module extraction', 'Each PM2 service is already independently deployable as a microservice'],
  ['Multi-region', 'Cloudflare routing enables geo-distribution; DB replication is the constraint'],
  ['Queue-based', 'BullMQ + Redis already handles all async workloads at scale'],
]);

// ══════════════════════════════════════════════════════
// 10. COMPLIANCE & LICENSING
// ══════════════════════════════════════════════════════
sectionHead('10. COMPLIANCE & LICENSING');
table(['Item', 'Status'], [
  ['CBN Licence', 'PSSP Licence — EagleCrest Premium Services Ltd'],
  ['KYC Framework', '3-tier KYC: BVN + NIN + CAC + liveness biometric capture'],
  ['AML Screening', 'Real-time PEP and global sanctions screening on all merchants'],
  ['Adverse Media', 'Automated adverse media intelligence screening'],
  ['Document Retention', 'All KYC docs and biometric selfies retained for law enforcement'],
  ['Data Residency', 'Primary data stored EU (Germany, Contabo)'],
  ['Webhook Security', 'HMAC-SHA256 signed webhooks to prevent replay attacks'],
  ['Mastercard Compliance', 'MPGS portal with dedicated compliance exception tracking'],
]);

// ══════════════════════════════════════════════════════
// 11. SUMMARY METRICS
// ══════════════════════════════════════════════════════
sectionHead('11. CODEBASE & PLATFORM SUMMARY');
table(['Metric', 'Value'], [
  ['Backend Language', 'JavaScript (Node.js v20 LTS)'],
  ['Frontend Language', 'Vanilla HTML5 / CSS3 / ES2020+'],
  ['Database', 'PostgreSQL 16 with Prisma ORM'],
  ['Backend Modules', '4 core modules: gateway-core, invoicing, wallet, assistant'],
  ['Database Tables', '67 tables across all product areas'],
  ['Running Services', '11 PM2-managed processes'],
  ['Active SSL Domains', '6 domains with auto-renewing certificates'],
  ['Test Environment', 'Full sandbox mode with separate test API keys'],
  ['Uptime Monitoring', 'Paylode Guardian + daily smoke tests'],
]);

// Footer
doc.moveDown(2);
doc.rect(50, doc.y, 495, 1).fill('#dddddd');
doc.moveDown(0.3);
doc.fillColor(GRAY).fontSize(8).font('Helvetica')
  .text('Paylode — EagleCrest Premium Services Ltd  |  CONFIDENTIAL — For Investor Review  |  August 2026', 50, doc.y, { align: 'center' });

doc.end();
console.log('PDF generated: /tmp/Paylode-Technology-Architecture.pdf');
