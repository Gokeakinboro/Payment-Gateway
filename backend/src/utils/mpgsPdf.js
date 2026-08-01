'use strict';
/**
 * Generates filled PDF documents for MPGS onboarding submissions.
 * Returns Promise<Buffer> for each form so the caller can attach them.
 */
const PDFDocument = require('pdfkit');
const path        = require('path');

const PARALLEX_LOGO = path.join(__dirname, '../../assets/mpgs/parallex-logo.png');

// ── Colour palette ─────────────────────────────────────────────────────────
const NAVY  = '#1a2744';
const PBLUE = '#1c2b6e';
const PGOLD = '#c8a84b';
const WHITE = '#ffffff';
const G50   = '#f8fafc';
const G200  = '#e2e8f0';
const G500  = '#64748b';
const G800  = '#1e293b';

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end',  ()  => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);
  });
}

function arr(v) {
  return Array.isArray(v) ? v.join(', ') : (v || '—');
}

// ── Shared layout helpers ──────────────────────────────────────────────────
function sectionHeader(doc, text, color) {
  doc.fillColor(color || NAVY)
     .rect(doc.page.margins.left, doc.y, doc.page.width - doc.page.margins.left - doc.page.margins.right, 18)
     .fill();
  doc.fillColor(WHITE)
     .fontSize(9).font('Helvetica-Bold')
     .text(text, doc.page.margins.left + 6, doc.y - 14);
  doc.moveDown(0.6);
}

function tableRow(doc, sn, label, value, isShaded) {
  const lm     = doc.page.margins.left;
  const width  = doc.page.width - lm - doc.page.margins.right;
  const snW    = 28;
  const labelW = 200;
  const valW   = width - snW - labelW;
  const rowH   = 20;
  const y      = doc.y;

  if (isShaded) {
    doc.fillColor(G50).rect(lm, y, width, rowH).fill();
  }
  doc.strokeColor(G200).lineWidth(0.5);
  doc.rect(lm,           y, width, rowH).stroke();
  doc.moveTo(lm + snW,   y).lineTo(lm + snW,   y + rowH).stroke();
  doc.moveTo(lm + snW + labelW, y).lineTo(lm + snW + labelW, y + rowH).stroke();

  doc.fillColor(G500).fontSize(8).font('Helvetica')
     .text(String(sn), lm + 3, y + 5, { width: snW - 4, lineBreak: false });
  doc.fillColor(G800).fontSize(8).font('Helvetica')
     .text(label, lm + snW + 4, y + 5, { width: labelW - 6, lineBreak: false });

  const valText = String(arr(value));
  const isMultiLine = valText.length > 60 || valText.includes('\n');
  if (isMultiLine) {
    const extraH = Math.ceil(valText.length / 70) * 10;
    doc.fillColor(G50).rect(lm + snW + labelW, y, valW, rowH + extraH).fill();
    doc.strokeColor(G200).rect(lm, y, width, rowH + extraH).stroke();
    doc.moveTo(lm + snW, y).lineTo(lm + snW, y + rowH + extraH).stroke();
    doc.moveTo(lm + snW + labelW, y).lineTo(lm + snW + labelW, y + rowH + extraH).stroke();
    doc.fillColor(G800).fontSize(8)
       .text(valText, lm + snW + labelW + 4, y + 5, { width: valW - 8 });
    doc.y = y + rowH + extraH;
  } else {
    doc.fillColor(G800).fontSize(8)
       .text(valText, lm + snW + labelW + 4, y + 5, { width: valW - 8, lineBreak: false });
    doc.y = y + rowH;
  }
}

function twoColRow(doc, label, primary, secondary) {
  const lm     = doc.page.margins.left;
  const width  = doc.page.width - lm - doc.page.margins.right;
  const labelW = 140;
  const colW   = (width - labelW) / 2;
  const rowH   = 20;
  const y      = doc.y;

  doc.strokeColor(G200).lineWidth(0.5);
  doc.rect(lm, y, width, rowH).stroke();
  doc.moveTo(lm + labelW, y).lineTo(lm + labelW, y + rowH).stroke();
  doc.moveTo(lm + labelW + colW, y).lineTo(lm + labelW + colW, y + rowH).stroke();

  doc.fillColor(G800).fontSize(8).font('Helvetica-Bold')
     .text(label, lm + 4, y + 5, { width: labelW - 6, lineBreak: false });
  doc.font('Helvetica')
     .text(String(arr(primary)),   lm + labelW + 4, y + 5, { width: colW - 6, lineBreak: false });
  doc.text(String(arr(secondary)), lm + labelW + colW + 4, y + 5, { width: colW - 6, lineBreak: false });
  doc.y = y + rowH;
}

function twoColHeader(doc, col1, col2) {
  const lm     = doc.page.margins.left;
  const width  = doc.page.width - lm - doc.page.margins.right;
  const labelW = 140;
  const colW   = (width - labelW) / 2;
  const y      = doc.y;

  doc.fillColor(G50).rect(lm, y, width, 18).fill();
  doc.strokeColor(G200).rect(lm, y, width, 18).stroke();
  doc.moveTo(lm + labelW, y).lineTo(lm + labelW, y + 18).stroke();
  doc.moveTo(lm + labelW + colW, y).lineTo(lm + labelW + colW, y + 18).stroke();
  doc.fillColor(PBLUE).fontSize(8).font('Helvetica-Bold')
     .text(col1, lm + labelW + 4, y + 4, { width: colW - 6, lineBreak: false });
  doc.fillColor(G500)
     .text(col2, lm + labelW + colW + 4, y + 4, { width: colW - 6, lineBreak: false });
  doc.y = y + 18;
}

function simpleRow(doc, label, value) {
  const lm     = doc.page.margins.left;
  const width  = doc.page.width - lm - doc.page.margins.right;
  const labelW = 200;
  const rowH   = 20;
  const y      = doc.y;

  doc.fillColor(G50).rect(lm, y, labelW, rowH).fill();
  doc.strokeColor(G200).rect(lm, y, width, rowH).stroke();
  doc.moveTo(lm + labelW, y).lineTo(lm + labelW, y + rowH).stroke();

  doc.fillColor(G800).fontSize(8).font('Helvetica-Bold')
     .text(label, lm + 4, y + 5, { width: labelW - 6, lineBreak: false });
  doc.font('Helvetica')
     .text(String(arr(value)), lm + labelW + 4, y + 5, { width: width - labelW - 8, lineBreak: false });
  doc.y = y + rowH;
}

// ═══════════════════════════════════════════════════════════════════════════
// QUESTIONNAIRE PDF
// ═══════════════════════════════════════════════════════════════════════════
async function generateQuestionnairePDF(q, merchantName) {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const p   = toBuffer(doc);

  // Header
  doc.fillColor(NAVY)
     .rect(40, 40, doc.page.width - 80, 36).fill();
  doc.fillColor(WHITE).fontSize(14).font('Helvetica-Bold')
     .text('WEB BUSINESS — QUESTIONNAIRE', 40, 50, { align: 'center', width: doc.page.width - 80 });
  doc.moveDown(1.2);

  if (merchantName) {
    doc.fillColor(G800).fontSize(9).font('Helvetica-Bold')
       .text('Merchant: ' + merchantName, { align: 'left' });
    doc.moveDown(0.3);
  }
  doc.fillColor(G500).fontSize(8).font('Helvetica')
     .text('Fields marked * are compulsory   |   Generated by Paylode MPGS Onboarding Portal', { align: 'left' });
  doc.moveDown(0.8);

  // Section A
  sectionHeader(doc, 'A.  GENERAL INFORMATION');
  const colHead = ['S/N', 'Items', 'Response'];
  const lm = doc.page.margins.left;
  const w  = doc.page.width - lm - doc.page.margins.right;
  doc.fillColor(G50).rect(lm, doc.y, w, 16).fill();
  doc.fillColor(G500).fontSize(7).font('Helvetica-Bold');
  ['S/N','Items','Response'].forEach((h, i) => {
    const x = i === 0 ? lm + 2 : i === 1 ? lm + 30 : lm + 232;
    doc.text(h, x, doc.y - 1, { lineBreak: false });
  });
  doc.y = doc.y + 10;

  [
    [1,'*Company Name',q.companyName],
    [2,'*Company Address (Head office)',q.companyAddress],
    [3,'*Length of stay at company address',q.lengthOfStay],
    [4,'*Country of location',q.country],
    [5,'*Full Name and Address of Directors',q.directors],
    [6,'*Company Registration Number',q.rcNumber],
    [7,'*Company Bank Verification Number',q.bvn],
    [8,'*Tax Identification Number',q.tin],
    [9,'*Number of years/months of operation',q.yearsOfOperation],
    [10,'*List of outlets and their address',q.outlets],
    [11,'*Website / URL / IP Address',q.website],
    [12,'*Customer service contact number and email',q.customerServiceContact],
    ['13a','Type of Goods or Services',q.typeOfGoods],
    ['13b','Merchant Category Code (MCC)',q.mcc],
    [14,'Statement of Account (3-6 months)','See attached bank statement document'],
    [15,'Previous Payment Engines (Yes or No)',q.prevPaymentEngines],
    [16,'Reason for leaving',q.reasonForLeaving],
    [17,'Address of merchant store/Warehouse',q.storeAddress],
  ].forEach(([n, label, val], i) => tableRow(doc, n, label, val, i % 2 === 0));

  doc.moveDown(0.8);
  sectionHeader(doc, 'B.  PAYMENT INFORMATION');
  [
    [1,'*Card brand (MasterCard, Visa etc.) Accepted',q.cardBrands],
    [2,'*Card currency (USD, NGN, GBP & Euro)',q.cardCurrencies],
    [3,'*Card types (Debit, Credit, Prepaid)',q.cardTypes],
    [4,'*Time frame for order processing (24hrs, 48hrs, 72hrs, others)',q.orderProcessingTime],
    [5,'*Payment model (2 party, 3 party or 2.5 party)',q.paymentModel],
    [6,'*Transaction model (Purchase or Auth/capture)',q.transactionModel],
    [7,'*Annual Sales Projection — Volume',q.annualVolume],
    ['','*Annual Sales Projection — Value',q.annualValue],
  ].forEach(([n, label, val], i) => tableRow(doc, n, label, val, i % 2 === 0));

  doc.moveDown(0.8);
  sectionHeader(doc, 'C.  SECURITY INFORMATION');
  [
    [1,'*PCIDSS Status (Certified, Work-In-Progress, Not Started)',q.pcidssStatus],
    [2,'*Advance Functionality (Void transaction, Refund, Query-Dr)',q.advanceFunctionality],
    [3,'*3-D Secure (Verify by Visa, MasterCard Secure Code or J/Secure)',q.threeDSecure],
    [4,'*Will send unique transaction & order reference (Yes or No)',q.uniqueRef],
  ].forEach(([n, label, val], i) => tableRow(doc, n, label, val, i % 2 === 0));

  doc.moveDown(0.8);
  sectionHeader(doc, 'D.  SALES INFORMATION');
  [
    [1,'*Estimated Sales — Daily',q.salesDaily],
    ['','*Estimated Sales — Weekly',q.salesWeekly],
    ['','*Estimated Sales — Monthly',q.salesMonthly],
    ['','*Estimated Sales — Annual',q.salesAnnual],
    [2,'*Highest goods/service value',q.highestValue],
    [3,'*Lowest goods/service value',q.lowestValue],
    [4,'*List of goods and services',q.goodsList],
  ].forEach(([n, label, val], i) => tableRow(doc, n, label, val, i % 2 === 0));

  // Footer
  doc.moveDown(1);
  doc.fillColor(G500).fontSize(7)
     .text('Generated by Paylode MPGS Onboarding Portal — mpgs.paylodeservices.com   |   ' + new Date().toLocaleDateString('en-GB'), { align: 'center' });

  doc.end();
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION FORM PDF
// ═══════════════════════════════════════════════════════════════════════════
function addLogoHeader(doc) {
  const lm    = doc.page.margins.left;
  const logoY = doc.page.margins.top;
  const logoW = 128;
  const logoH = 63;
  doc.image(PARALLEX_LOGO, lm, logoY, { width: logoW });
  doc.fillColor(PBLUE).fontSize(11).font('Helvetica-Bold')
     .text('PARALLEX BANK LIMITED', 0, logoY + 10, { align: 'right' });
  doc.fillColor(PBLUE).fontSize(10).font('Helvetica-Bold')
     .text('RC 747627', 0, logoY + 26, { align: 'right' });
  doc.y = logoY + logoH + 8;
}

async function generateApplicationFormPDF(f, merchantName) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', autoFirstPage: false });
  const p   = toBuffer(doc);

  // Add page 1 with logo header
  doc.addPage();
  const lm  = doc.page.margins.left;
  const w   = doc.page.width - lm - doc.page.margins.right;

  // Register before any subsequent auto-pages; call manually for page 1
  doc.on('pageAdded', () => addLogoHeader(doc));
  addLogoHeader(doc);
  doc.moveDown(0.4);

  // Title bar
  doc.fillColor(PBLUE).rect(lm, doc.y, w, 20).fill();
  doc.fillColor(WHITE).fontSize(11).font('Helvetica-Bold')
     .text('PARALLEX PAYMENT GATEWAY', lm, doc.y - 15, { align: 'center', width: w });
  doc.moveDown(0.4);

  doc.strokeColor(G200).lineWidth(0.5).rect(lm, doc.y, w, 16).stroke();
  doc.fillColor(G800).fontSize(10).font('Helvetica-Bold')
     .text('MERCHANT APPLICATION FORM', lm, doc.y + 2, { align: 'center', width: w });
  doc.y = doc.y + 18;

  // Instructions
  doc.moveDown(0.4);
  doc.fillColor(G500).fontSize(7.5).font('Helvetica')
     .text('Please complete this form and provide documentary evidence as appropriate. Submission of fraudulent documentation and false information will lead to refusal of this application and denial of service.', { width: w })
     .text('Instructions [All fields with * are COMPULSORY]  |  Complete every part of this form in BLOCK LETTERS.', { width: w });
  doc.moveDown(0.6);

  // Section 1
  sectionHeader(doc, 'SECTION 1: GENERAL INFORMATION', PBLUE);
  doc.fillColor(G500).fontSize(7.5).font('Helvetica')
     .text('Please complete this section with information about your organization. You should also attach a copy of your company\'s certificate of incorporation.', { width: w });
  doc.moveDown(0.4);
  [
    ['* Company Name', f.s1CompanyName],
    ['* Company Address', f.s1CompanyAddress],
    ['Type of Ownership', f.s1OwnershipType],
    ['RC Number', f.s1RcNumber],
    ['Trading Name', f.s1TradingName],
    ['Date Registered', f.s1DateRegistered],
    ['Tax Identification Number', f.s1Tin],
  ].forEach(([l, v]) => simpleRow(doc, l, v));

  doc.moveDown(0.6);
  sectionHeader(doc, 'SECTION 2: CONTACT INFORMATION', PBLUE);
  doc.fillColor(G500).fontSize(7.5).font('Helvetica')
     .text('All correspondence between Parallex Bank Ltd and your organization will be addressed to the persons specified below.', { width: w });
  doc.moveDown(0.4);
  twoColHeader(doc, 'Primary Contact Person', 'Secondary Contact Person');
  [
    ['Name', f.s2PrimaryName, f.s2SecondaryName],
    ['Designation', f.s2PrimaryDesignation, f.s2SecondaryDesignation],
    ['Office Tel/Extension', f.s2PrimaryOfficeTel, f.s2SecondaryOfficeTel],
    ['Mobile Phone', f.s2PrimaryMobile, f.s2SecondaryMobile],
    ['Email Address', f.s2PrimaryEmail, f.s2SecondaryEmail],
  ].forEach(([l, p1, p2]) => twoColRow(doc, l, p1, p2));

  doc.moveDown(0.6);
  sectionHeader(doc, 'SECTION 3: ECOMMERCE WEBSITE INFORMATION', PBLUE);
  doc.fillColor(G500).fontSize(7.5).font('Helvetica')
     .text('Please supply information about the products you intend to provide on the website and Merchant category code (MCC).', { width: w });
  doc.moveDown(0.4);
  if (f.s3ProductsMcc) {
    doc.fillColor(G800).fontSize(8).font('Helvetica')
       .text(f.s3ProductsMcc, lm + 4, doc.y, { width: w - 8 });
    doc.moveDown(0.3);
  }
  [
    ['* Website Name', f.s3WebsiteName],
    ['* Website URL', f.s3WebsiteUrl],
  ].forEach(([l, v]) => simpleRow(doc, l, v));

  doc.moveDown(0.6);
  sectionHeader(doc, 'SECTION 4: BANK DETAILS', PBLUE);
  doc.fillColor(G500).fontSize(7.5).font('Helvetica')
     .text('Complete this section with your information with the Bank. Payments made via website will be deposited into the account details supplied.', { width: w });
  doc.moveDown(0.4);
  [
    ['Account Number', f.s4AccountNumber],
    ['Account Name', f.s4AccountName],
    ['Account Type', f.s4AccountType],
    ['Settlement Account', f.s4SettlementAccount],
    ['Collateral Account', f.s4CollateralAccount],
    ['Branch Where Account is Domiciled', f.s4Branch],
  ].forEach(([l, v]) => simpleRow(doc, l, v));

  doc.moveDown(0.6);
  sectionHeader(doc, 'SECTION 5: OTHER DETAILS ONLY', PBLUE);
  doc.fillColor(G500).fontSize(7.5).font('Helvetica')
     .text('Please provide any other additional information in the space below.', { width: w });
  doc.moveDown(0.4);
  if (f.s5OtherDetails) {
    doc.strokeColor(G200).rect(lm, doc.y, w, 0).stroke();
    doc.fillColor(G800).fontSize(8).font('Helvetica')
       .text(f.s5OtherDetails, lm + 4, doc.y + 2, { width: w - 8 });
    doc.moveDown(0.6);
  }
  // Declaration
  doc.fillColor(G800).fontSize(8).font('Helvetica')
     .text('I ............' + (f.s5IndividualName || '').padEnd(40, '.') + ' on behalf of ' + (f.s5CompanyName || '.....................') + ' hereby certify that the information provided on this form is true and accurate. I agree that Parallex Bank Ltd reserves the right to take appropriate measures including legal actions if the information here is discovered to be false. I agree that I will provide Parallex Bank Ltd with details of transactions performed on the site upon demand.', { width: w });
  doc.moveDown(0.6);

  const sigY = doc.y;
  doc.fillColor(G800).fontSize(8).font('Helvetica-Bold').text('AUTHORIZED SIGNATURE:', lm, sigY);
  doc.font('Helvetica').text(f.s5AuthSig || '________________________', lm + 130, sigY);
  doc.font('Helvetica-Bold').text('DESIGNATION:', lm + 290, sigY);
  doc.font('Helvetica').text(f.s5Designation || '______________', lm + 360, sigY);
  doc.font('Helvetica-Bold').text('DATE:', lm + 440, sigY);
  doc.font('Helvetica').text(f.s5Date || '__________', lm + 468, sigY);
  doc.moveDown(0.8);

  sectionHeader(doc, 'SECTION 6: MERCHANT INFORMATION', PBLUE);
  doc.fillColor(G800).fontSize(8).font('Helvetica-Bold')
     .text('TICK THE ONBOARDING TYPE:', lm, doc.y + 4);
  const types = ['DIRECT MERCHANT', 'PAYMENT FACILITATOR', 'MSO'];
  types.forEach((t, i) => {
    const isSelected = (f.s6OnboardingType || '').toUpperCase().includes(t.replace('PAYMENT FACILITATOR', 'FACILITATOR').split(' ')[0]);
    doc.strokeColor(PBLUE).lineWidth(0.8).rect(lm + 160 + i * 110, doc.y - 4, 10, 10).stroke();
    if (isSelected) {
      doc.fillColor(PBLUE).rect(lm + 162 + i * 110, doc.y - 2, 6, 6).fill();
    }
    doc.fillColor(G800).font('Helvetica').fontSize(8)
       .text(t, lm + 175 + i * 110, doc.y - 3, { lineBreak: false });
  });
  doc.moveDown(1.2);

  sectionHeader(doc, 'SECTION 7: E-COMMERCE WEBSITE INFORMATION (FOR BANK USE ONLY)', PBLUE);
  [
    ['Appropriate KYC in place', ''],
    ['Select requisite actions taken — References', ''],
    ['Account Officer\'s Name', ''],
    ['Account Officer\'s Signature', ''],
    ['Web Business Sign Off', ''],
  ].forEach(([l, v]) => simpleRow(doc, l, v));

  // Footer
  doc.moveDown(1);
  doc.fillColor(G500).fontSize(7)
     .text('Generated by Paylode MPGS Onboarding Portal — mpgs.paylodeservices.com   |   ' + new Date().toLocaleDateString('en-GB'), { align: 'center' });

  doc.end();
  return p;
}

module.exports = { generateQuestionnairePDF, generateApplicationFormPDF };
