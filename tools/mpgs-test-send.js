'use strict';
require('dotenv').config({ path: '/opt/paylode-api/backend/.env' });
const nodemailer = require('/opt/paylode-api/backend/node_modules/nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Test data ──────────────────────────────────────────────────────────────
const q = {
  companyName: 'XYZ Limited',
  companyAddress: '14 Marina Road, Lagos Island, Lagos State, Nigeria',
  lengthOfStay: '3 years',
  country: 'Nigeria',
  directors: 'Goke Akinboro — 12 Allen Avenue, Ikeja, Lagos\nBola Adesanya — 4 Bourdillon Road, Ikoyi, Lagos',
  rcNumber: 'RC 987654',
  bvn: '22123456789',
  tin: 'TIN-2024-XYZ01',
  yearsOfOperation: '3 years 6 months',
  outlets: '14 Marina Road, Lagos Island (Head Office)\n8 Wuse Zone 5, Abuja (Branch)',
  website: 'https://www.xyzlimited.com',
  customerServiceContact: '+234 801 234 5678 | support@xyzlimited.com',
  typeOfGoods: 'Fashion and Apparel — online retail sales',
  mcc: '5621',
  prevPaymentEngines: 'No',
  storeAddress: 'Same as head office',
  cardBrands: ['MasterCard', 'Visa', 'Verve'],
  cardCurrencies: ['NGN', 'USD'],
  cardTypes: ['Debit', 'Credit'],
  orderProcessingTime: 'Within 24hrs',
  paymentModel: '3 party',
  transactionModel: 'Purchase',
  annualVolume: '12,000 transactions',
  annualValue: 'NGN 180,000,000',
  pcidssStatus: 'Not Started',
  advanceFunctionality: ['Refund', 'Query-Dr'],
  threeDSecure: ['MasterCard Secure Code'],
  uniqueRef: 'Yes',
  salesDaily: 'NGN 500,000',
  salesWeekly: 'NGN 3,000,000',
  salesMonthly: 'NGN 15,000,000',
  salesAnnual: 'NGN 180,000,000',
  highestValue: 'NGN 500,000',
  lowestValue: 'NGN 5,000',
  goodsList: "Women's fashion (dresses, shoes, bags)\nMen's wear (shirts, trousers, suits)\nChildren's clothing and accessories",
};

const f = {
  s1CompanyName: 'XYZ Limited',
  s1CompanyAddress: '14 Marina Road, Lagos Island, Lagos State',
  s1OwnershipType: 'Limited Liability Company',
  s1RcNumber: 'RC 987654',
  s1TradingName: 'XYZ Fashion Store',
  s1DateRegistered: '2021-03-15',
  s1Tin: 'TIN-2024-XYZ01',
  s2PrimaryName: 'Goke Akinboro',
  s2PrimaryDesignation: 'Managing Director',
  s2PrimaryOfficeTel: '+234 801 234 5678',
  s2PrimaryMobile: '+234 802 345 6789',
  s2PrimaryEmail: 'goke@xyzlimited.com',
  s2SecondaryName: 'Bola Adesanya',
  s2SecondaryDesignation: 'Chief Financial Officer',
  s2SecondaryOfficeTel: '+234 803 456 7890',
  s2SecondaryMobile: '+234 804 567 8901',
  s2SecondaryEmail: 'bola@xyzlimited.com',
  s3ProductsMcc: 'Online retail of fashion, apparel and accessories via e-commerce website. MCC: 5621 (Clothing Stores)',
  s3WebsiteName: 'XYZ Fashion Store',
  s3WebsiteUrl: 'https://www.xyzlimited.com',
  s4AccountNumber: '0123456789',
  s4AccountName: 'XYZ Limited',
  s4AccountType: 'Current',
  s4SettlementAccount: '0123456789',
  s4CollateralAccount: 'N/A',
  s4Branch: 'Marina Branch, Lagos Island',
  s5OtherDetails: 'We have an existing customer base of over 5,000 registered users and process approximately 1,000 transactions per month. We are seeking MPGS integration to improve our checkout experience and expand card acceptance.',
  s5IndividualName: 'Goke Akinboro',
  s5CompanyName: 'XYZ Limited',
  s5AuthSig: 'G. Akinboro',
  s5Designation: 'Managing Director',
  s5Date: new Date().toISOString().split('T')[0],
  s6OnboardingType: 'Payment Facilitator',
};

// ── HTML helpers ────────────────────────────────────────────────────────────
function tdRow(n, label, val) {
  const v = Array.isArray(val) ? val.join(', ') : (val || '—');
  return '<tr>'
    + '<td style="padding:7px 10px;border:1px solid #e2e8f0;color:#64748b;width:36px;font-size:12px">' + n + '</td>'
    + '<td style="padding:7px 10px;border:1px solid #e2e8f0;width:230px;font-size:13px">' + label + '</td>'
    + '<td style="padding:7px 10px;border:1px solid #e2e8f0;font-size:13px">' + v + '</td>'
    + '</tr>';
}
function section(title, rows) {
  return '<h3 style="font-size:13px;color:#334155;background:#f1f5f9;padding:8px 10px;margin:14px 0 0;border:1px solid #e2e8f0">' + title + '</h3>'
    + '<table style="width:100%;border-collapse:collapse"><tbody>' + rows.join('') + '</tbody></table>';
}

const questHtml = '<hr style="margin:24px 0;border:none;border-top:2px solid #e2e8f0">'
  + '<h2 style="color:#1a2744;font-size:15px;margin-bottom:10px">WEB BUSINESS — QUESTIONNAIRE</h2>'
  + section('A. GENERAL INFORMATION', [
      tdRow(1,'Company Name',q.companyName),
      tdRow(2,'Company Address (Head office)',q.companyAddress),
      tdRow(3,'Length of stay at company address',q.lengthOfStay),
      tdRow(4,'Country of location',q.country),
      tdRow(5,'Full Name and Address of Directors',q.directors),
      tdRow(6,'Company Registration Number',q.rcNumber),
      tdRow(7,'Company Bank Verification Number',q.bvn),
      tdRow(8,'Tax Identification Number',q.tin),
      tdRow(9,'Number of years/months of operation',q.yearsOfOperation),
      tdRow(10,'List of outlets and their address',q.outlets),
      tdRow(11,'Website / URL / IP Address',q.website),
      tdRow(12,'Customer service contact number and email',q.customerServiceContact),
      tdRow('13a','Type of Goods or Services',q.typeOfGoods),
      tdRow('13b','Merchant Category Code (MCC)',q.mcc),
      tdRow(15,'Previous Payment Engines (Yes or No)',q.prevPaymentEngines),
      tdRow(17,'Address of merchant store/Warehouse',q.storeAddress),
    ])
  + section('B. PAYMENT INFORMATION', [
      tdRow(1,'Card brand (MasterCard, Visa etc.) Accepted',q.cardBrands),
      tdRow(2,'Card currency (USD, NGN, GBP & Euro)',q.cardCurrencies),
      tdRow(3,'Card types (Debit, Credit, Prepaid)',q.cardTypes),
      tdRow(4,'Time frame for order processing',q.orderProcessingTime),
      tdRow(5,'Payment model (2 party, 3 party or 2.5 party)',q.paymentModel),
      tdRow(6,'Transaction model (Purchase or Auth/capture)',q.transactionModel),
      tdRow('7','Annual Sales Projection — Volume',q.annualVolume),
      tdRow('7','Annual Sales Projection — Value',q.annualValue),
    ])
  + section('C. SECURITY INFORMATION', [
      tdRow(1,'PCIDSS Status (Certified, Work-In-Progress, Not Started)',q.pcidssStatus),
      tdRow(2,'Advance Functionality (Void transaction, Refund, Query-Dr)',q.advanceFunctionality),
      tdRow(3,'3-D Secure (Verify by Visa, MasterCard Secure Code or J/Secure)',q.threeDSecure),
      tdRow(4,'Will send unique transaction & order reference (Yes or No)',q.uniqueRef),
    ])
  + section('D. SALES INFORMATION', [
      tdRow(1,'Estimated Sales — Daily',q.salesDaily),
      tdRow('','Estimated Sales — Weekly',q.salesWeekly),
      tdRow('','Estimated Sales — Monthly',q.salesMonthly),
      tdRow('','Estimated Sales — Annual',q.salesAnnual),
      tdRow(2,'Highest goods/service value',q.highestValue),
      tdRow(3,'Lowest goods/service value',q.lowestValue),
      tdRow(4,'List of goods and services',q.goodsList),
    ]);

function r2(l, v) {
  return '<tr>'
    + '<td style="padding:8px 12px;border:1px solid #e2e8f0;width:220px;background:#f8fafc;font-weight:600;font-size:13px">' + l + '</td>'
    + '<td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px">' + (v || '—') + '</td>'
    + '</tr>';
}

const appFormHtml = '<hr style="margin:24px 0;border:none;border-top:2px solid #e2e8f0">'
  + '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px">'
  + '<tr>'
  + '<td width="56" valign="middle"><svg width="52" height="52" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="22" stroke="#1c2b6e" stroke-width="2.5"/><circle cx="24" cy="24" r="14" stroke="#1c2b6e" stroke-width="1.5"/><circle cx="24" cy="24" r="6" fill="#1c2b6e"/><line x1="24" y1="2" x2="24" y2="10" stroke="#1c2b6e" stroke-width="2" stroke-linecap="round"/><line x1="24" y1="38" x2="24" y2="46" stroke="#1c2b6e" stroke-width="2" stroke-linecap="round"/><line x1="2" y1="24" x2="10" y2="24" stroke="#1c2b6e" stroke-width="2" stroke-linecap="round"/><line x1="38" y1="24" x2="46" y2="24" stroke="#1c2b6e" stroke-width="2" stroke-linecap="round"/><line x1="7" y1="7" x2="13" y2="13" stroke="#c8a84b" stroke-width="2" stroke-linecap="round"/><line x1="35" y1="35" x2="41" y2="41" stroke="#c8a84b" stroke-width="2" stroke-linecap="round"/><line x1="41" y1="7" x2="35" y2="13" stroke="#c8a84b" stroke-width="2" stroke-linecap="round"/><line x1="13" y1="35" x2="7" y2="41" stroke="#c8a84b" stroke-width="2" stroke-linecap="round"/></svg></td>'
  + '<td valign="middle" style="padding-left:12px"><div style="font-size:20px;font-weight:700;color:#1c2b6e;font-style:italic">parallex</div><div style="font-size:10px;color:#64748b;letter-spacing:.5px">BANK</div></td>'
  + '<td align="right" valign="middle"><strong style="color:#1c2b6e;font-size:13px">PARALLEX BANK LIMITED</strong><br><span style="font-size:11px;color:#64748b">RC 747627</span></td>'
  + '</tr></table>'
  + '<div style="background:#1c2b6e;padding:10px 14px;text-align:center;color:#fff;font-size:13px;font-weight:700">PARALLEX PAYMENT GATEWAY</div>'
  + '<div style="border:1px solid #e2e8f0;border-top:none;padding:8px 14px;text-align:center;font-size:12px;font-weight:600;color:#334155">MERCHANT APPLICATION FORM</div>'
  + '<p style="font-size:11px;color:#475569;font-style:italic;margin:10px 0 0;padding:0 4px">Please complete this form and provide documentary evidence as appropriate. Submission of fraudulent documentation and false information will lead to refusal of this application. [All fields with * are COMPULSORY]</p>'
  + '<div style="background:#1c2b6e;padding:8px 12px;color:#fff;font-size:12px;font-weight:700;margin-top:12px">SECTION 1: GENERAL INFORMATION</div>'
  + '<table style="width:100%;border-collapse:collapse">' + [r2('* Company Name',f.s1CompanyName),r2('* Company Address',f.s1CompanyAddress),r2('Type of Ownership',f.s1OwnershipType),r2('RC Number',f.s1RcNumber),r2('Trading Name',f.s1TradingName),r2('Date Registered',f.s1DateRegistered),r2('Tax Identification Number',f.s1Tin)].join('') + '</table>'
  + '<div style="background:#1c2b6e;padding:8px 12px;color:#fff;font-size:12px;font-weight:700;margin-top:12px">SECTION 2: CONTACT INFORMATION</div>'
  + '<table style="width:100%;border-collapse:collapse"><tr><th style="padding:8px 12px;background:#f1f5f9;border:1px solid #e2e8f0;font-size:11px;font-weight:700;color:#64748b;text-align:left;text-transform:uppercase"></th><th style="padding:8px 12px;background:#f1f5f9;border:1px solid #e2e8f0;font-size:11px;font-weight:700;color:#1c2b6e;text-transform:uppercase">Primary Contact</th><th style="padding:8px 12px;background:#f1f5f9;border:1px solid #e2e8f0;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase">Secondary Contact</th></tr>'
  + [['* Name','s2PrimaryName','s2SecondaryName'],['Designation','s2PrimaryDesignation','s2SecondaryDesignation'],['Office Telephone/Ext','s2PrimaryOfficeTel','s2SecondaryOfficeTel'],['Mobile Phone','s2PrimaryMobile','s2SecondaryMobile'],['Email Address','s2PrimaryEmail','s2SecondaryEmail']].map(function(row) { return '<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;font-size:13px">' + row[0] + '</td><td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px">' + (f[row[1]]||'—') + '</td><td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px">' + (f[row[2]]||'—') + '</td></tr>'; }).join('')
  + '</table>'
  + '<div style="background:#1c2b6e;padding:8px 12px;color:#fff;font-size:12px;font-weight:700;margin-top:12px">SECTION 3: ECOMMERCE WEBSITE INFORMATION</div>'
  + '<table style="width:100%;border-collapse:collapse">' + [r2('Products / Services & MCC',f.s3ProductsMcc),r2('* Website Name',f.s3WebsiteName),r2('* Website URL',f.s3WebsiteUrl)].join('') + '</table>'
  + '<div style="background:#1c2b6e;padding:8px 12px;color:#fff;font-size:12px;font-weight:700;margin-top:12px">SECTION 4: BANK DETAILS</div>'
  + '<table style="width:100%;border-collapse:collapse">' + [r2('Account Number',f.s4AccountNumber),r2('Account Name',f.s4AccountName),r2('Account Type',f.s4AccountType),r2('Settlement Account',f.s4SettlementAccount),r2('Collateral Account',f.s4CollateralAccount),r2('Branch Where Account is Domiciled',f.s4Branch)].join('') + '</table>'
  + '<div style="background:#1c2b6e;padding:8px 12px;color:#fff;font-size:12px;font-weight:700;margin-top:12px">SECTION 5: OTHER DETAILS ONLY</div>'
  + '<div style="padding:12px;border:1px solid #e2e8f0;font-size:13px;color:#334155">' + f.s5OtherDetails + '</div>'
  + '<div style="padding:12px;border:1px solid #e2e8f0;border-top:none;font-size:12px;color:#475569;line-height:1.8">I, <strong>' + f.s5IndividualName + '</strong>, on behalf of <strong>' + f.s5CompanyName + '</strong>, hereby certify that the information provided on this form is true and accurate. I agree that Parallex Bank Ltd reserves the right to take appropriate measures including legal actions if the information here is discovered to be false.<br><br><strong>Authorized Signature:</strong> ' + f.s5AuthSig + ' &nbsp;&nbsp;&nbsp; <strong>Designation:</strong> ' + f.s5Designation + ' &nbsp;&nbsp;&nbsp; <strong>Date:</strong> ' + f.s5Date + '</div>'
  + '<div style="background:#1c2b6e;padding:8px 12px;color:#fff;font-size:12px;font-weight:700;margin-top:12px">SECTION 6: MERCHANT INFORMATION</div>'
  + '<div style="padding:12px;border:1px solid #e2e8f0;font-size:13px"><strong>Onboarding Type:</strong> ' + f.s6OnboardingType + '</div>';

// ── Full email ──────────────────────────────────────────────────────────────
const html = '<div style="font-family:Arial,sans-serif;max-width:760px;margin:0 auto;color:#1e293b">'
  + '<div style="background:#1a2744;padding:20px 28px;border-radius:10px 10px 0 0">'
  + '<p style="color:#fff;font-size:16px;font-weight:bold;margin:0">Parallex Bank MPGS Onboarding — Submitted via Paylode Services</p>'
  + '<p style="color:rgba(255,255,255,.55);font-size:12px;margin:4px 0 0">TEST email — please review formatting before going live</p>'
  + '</div>'
  + '<div style="background:#f8fafc;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">'
  + '<table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">'
  + '<tr><td style="padding:5px 0;color:#475569;width:160px">Merchant:</td><td style="padding:5px 0;font-weight:600">XYZ Limited</td></tr>'
  + '<tr><td style="padding:5px 0;color:#475569">Submitted by:</td><td style="padding:5px 0">Goke Akinboro (goke@xyzlimited.com)</td></tr>'
  + '<tr><td style="padding:5px 0;color:#475569">Sent by (Paylode):</td><td style="padding:5px 0">gokeakinboro@paylodeservices.com</td></tr>'
  + '<tr><td style="padding:5px 0;color:#475569">Attachments:</td><td style="padding:5px 0">None — this is a formatting test</td></tr>'
  + '</table>'
  + questHtml
  + appFormHtml
  + '</div>'
  + '<p style="font-size:11px;color:#94a3b8;text-align:center;margin-top:12px">Sent via Paylode MPGS Onboarding Portal — mpgs.paylodeservices.com</p>'
  + '</div>';

transporter.sendMail({
  from: '"Paylode Services" <' + (process.env.EMAIL_FROM || 'product@paylodeservices.com') + '>',
  to:   'gokeakinboro@gmail.com',
  subject: '[TEST] MPGS Onboarding Application — XYZ Limited',
  html:  html,
}, function(err, info) {
  if (err) { console.error('SEND FAILED:', err.message); process.exit(1); }
  console.log('SENT OK — messageId:', info.messageId);
  console.log('Preview URL:', nodemailer.getTestMessageUrl ? nodemailer.getTestMessageUrl(info) : 'n/a');
  process.exit(0);
});
