'use strict';
/**
 * Standalone test: generates MPGS PDFs and emails them to a recipient.
 * Run on the server where .env is configured:
 *   node tools/test-mpgs-email.js [recipient@email.com]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { generateQuestionnairePDF, generateApplicationFormPDF } = require('../src/utils/mpgsPdf');
const { generateCustomerDataSheetXlsx } = require('../src/utils/mpgsExcel');
const { sendEmail } = require('../src/services/emailService');

const RECIPIENT = process.argv[2] || 'gokeakinboro@gmail.com';

const SAMPLE_Q = {
  companyName: 'XYZ Limited',
  companyAddress: '15 Marina Road, Victoria Island, Lagos',
  lengthOfStay: '5 years',
  country: 'Nigeria',
  directors: 'John Doe — 15 Marina Road, Lagos; Jane Doe — 10 Adeola Odeku, V/I',
  rcNumber: 'RC123456',
  bvn: '22012345678',
  tin: 'TIN-987654321',
  yearsOfOperation: '7 years',
  outlets: '1. Head Office — 15 Marina Road VI; 2. Lekki Branch — 5 Admiralty Way',
  website: 'https://xyzlimited.com',
  customerServiceContact: '+234 800 999 1234 | support@xyzlimited.com',
  typeOfGoods: 'Electronics & consumer gadgets',
  mcc: '5732',
  prevPaymentEngines: 'Yes — Interswitch',
  reasonForLeaving: 'Higher transaction limits and better support required',
  storeAddress: '22 Warehouse Lane, Apapa, Lagos',
  cardBrands: ['MasterCard', 'Visa'],
  cardCurrencies: ['NGN', 'USD'],
  cardTypes: ['Debit', 'Credit'],
  orderProcessingTime: '24 hours',
  paymentModel: '3 party',
  transactionModel: 'Purchase',
  annualVolume: '50,000 transactions',
  annualValue: '₦2,500,000,000',
  pcidssStatus: 'Work-In-Progress',
  advanceFunctionality: 'Void, Refund, Query-Dr',
  threeDSecure: 'MasterCard Secure Code',
  uniqueRef: 'Yes',
  salesDaily: '₦6,849,315',
  salesWeekly: '₦47,945,205',
  salesMonthly: '₦208,333,333',
  salesAnnual: '₦2,500,000,000',
  highestValue: '₦500,000',
  lowestValue: '₦5,000',
  goodsList: 'Smartphones, Laptops, Accessories, Smart TVs',
};

const SAMPLE_F = {
  s1CompanyName: 'XYZ Limited',
  s1CompanyAddress: '15 Marina Road, Victoria Island, Lagos',
  s1OwnershipType: 'Limited Liability Company',
  s1RcNumber: 'RC123456',
  s1TradingName: 'XYZ Store',
  s1DateRegistered: '12/03/2017',
  s1Tin: 'TIN-987654321',
  s2PrimaryName: 'John Doe',
  s2PrimaryDesignation: 'Chief Executive Officer',
  s2PrimaryOfficeTel: '+234 1 234 5678',
  s2PrimaryMobile: '+234 803 000 1111',
  s2PrimaryEmail: 'john.doe@xyzlimited.com',
  s2SecondaryName: 'Jane Doe',
  s2SecondaryDesignation: 'Finance Director',
  s2SecondaryOfficeTel: '+234 1 234 5679',
  s2SecondaryMobile: '+234 803 000 2222',
  s2SecondaryEmail: 'jane.doe@xyzlimited.com',
  s3ProductsMcc: 'Electronics & consumer gadgets — MCC 5732',
  s3WebsiteName: 'XYZ Limited Online Store',
  s3WebsiteUrl: 'https://shop.xyzlimited.com',
  s4AccountNumber: '0012345678',
  s4AccountName: 'XYZ Limited',
  s4AccountType: 'Current',
  s4SettlementAccount: '0012345679',
  s4CollateralAccount: '0012345680',
  s4Branch: 'Victoria Island Branch',
  s5OtherDetails: 'All transactions will originate from Nigerian customers only.',
  s5IndividualName: 'John Doe',
  s5CompanyName: 'XYZ Limited',
  s5AuthSig: 'John Doe',
  s5Designation: 'CEO',
  s5Date: new Date().toLocaleDateString('en-GB'),
  s6OnboardingType: 'DIRECT MERCHANT',
};

async function main() {
  console.log('Generating PDFs and Excel…');
  const [qBuf, fBuf] = await Promise.all([
    generateQuestionnairePDF(SAMPLE_Q, 'XYZ Limited'),
    generateApplicationFormPDF(SAMPLE_F, 'XYZ Limited'),
  ]);
  const xlsBuf = generateCustomerDataSheetXlsx(SAMPLE_Q, SAMPLE_F, 'XYZ Limited');
  console.log(`  Questionnaire PDF: ${qBuf.length} bytes`);
  console.log(`  Application Form PDF: ${fBuf.length} bytes`);
  console.log(`  Customer Data Sheet XLSX: ${xlsBuf.length} bytes`);

  console.log(`Sending test email to ${RECIPIENT}…`);
  await sendEmail({
    to: RECIPIENT,
    subject: '[TEST] MPGS Onboarding Application — XYZ Limited',
    html: `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:#1a2744;padding:20px 28px;border-radius:8px 8px 0 0">
        <p style="color:#fff;font-size:16px;font-weight:bold;margin:0">Parallex Bank MPGS Onboarding — Submitted via Paylode Services</p>
        <p style="color:#94a3b8;font-size:12px;margin:4px 0 0">TEST email</p>
      </div>
      <div style="background:#f8fafc;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p><strong>Merchant:</strong> XYZ Limited</p>
        <p><strong>Submitted by:</strong> Test User (test@example.com)</p>
        <p><strong>Sent by (Paylode):</strong> admin@paylodeservices.com</p>
        <p><strong>Attachments (3):</strong> MPGS_Questionnaire.pdf, Parallex_Application_Form.pdf, Customer_Data_Sheet.xlsx</p>
        <p style="color:#64748b;font-size:12px">All forms are attached. The Excel sheet is pre-filled with merchant data.</p>
      </div>
    </div>`,
    attachments: [
      { filename: 'MPGS_Questionnaire.pdf', content: qBuf, contentType: 'application/pdf' },
      { filename: 'Parallex_Application_Form.pdf', content: fBuf, contentType: 'application/pdf' },
      { filename: 'Customer_Data_Sheet.xlsx', content: xlsBuf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ],
  });

  console.log('Done — email sent.');
}

main().catch(e => { console.error(e); process.exit(1); });
