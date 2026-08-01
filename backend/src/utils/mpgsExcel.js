'use strict';
/**
 * Fills the Parallex "Customer data sheet" Excel template with
 * data from the MPGS application and returns a Buffer for attaching to email.
 */
const XLSX = require('xlsx');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '../../assets/mpgs/customer-data-sheet-template.xlsx');

function val(v) { return Array.isArray(v) ? v.join(', ') : (v || ''); }

/**
 * @param {object} q  - app.questionnaire
 * @param {object} f  - app.applicationForm
 * @param {string} merchantName - top-level app.merchantName
 * @returns {Buffer}
 */
function generateCustomerDataSheetXlsx(q, f, merchantName) {
  q = q || {};
  f = f || {};

  const wb = XLSX.readFile(TEMPLATE_PATH);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // Determine the next empty row (template has header in row 1)
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const dataRow = range.e.r + 1; // 0-indexed row after last row

  // Column order must match the template header exactly:
  // URL | Legal Business/Merchant Name | Billing Descriptor | Merchant DBA |
  // MCC | MasterCard ICA | Visa BIN | Address 1 | Address 2 | City |
  // Region/State | Country | Postal/Zip Code | Phone Number | Email Address |
  // Principal Name | ID card No. | Principal Address 1 | Principal Address 2 |
  // Principal City | Principal Region/State | Principal Country |
  // Principal Postal/Zip Code | Principal Phone Number | Principal Email Address |
  // Primary Merchant Contact Name | Products/Services Description |
  // Data Field 1 | Data Field 2 | Data Field 3
  const rowData = [
    val(f.s3WebsiteUrl || q.website),                        // URL
    val(f.s1CompanyName || q.companyName || merchantName),   // Legal Business/Merchant Name
    val(f.s1TradingName || f.s1CompanyName || merchantName), // Billing Descriptor
    val(f.s1TradingName || ''),                              // Merchant DBA
    val(q.mcc),                                              // MCC
    '',                                                       // MasterCard ICA
    '',                                                       // Visa BIN
    val(f.s1CompanyAddress || q.companyAddress),             // Address 1
    '',                                                       // Address 2
    '',                                                       // City
    '',                                                       // Region/State
    val(q.country || 'Nigeria'),                             // Country
    '',                                                       // Postal/Zip Code
    val(f.s2PrimaryOfficeTel || f.s2PrimaryMobile || q.customerServiceContact), // Phone Number
    val(f.s2PrimaryEmail || ''),                             // Email Address
    val(f.s2PrimaryName || q.directors),                     // Principal Name
    '',                                                       // ID card No.
    val(f.s1CompanyAddress || q.companyAddress),             // Principal Address 1
    '',                                                       // Principal Address 2
    '',                                                       // Principal City
    '',                                                       // Principal Region/State
    val(q.country || 'Nigeria'),                             // Principal Country
    '',                                                       // Principal Postal/Zip Code
    val(f.s2PrimaryMobile || ''),                            // Principal Phone Number
    val(f.s2PrimaryEmail || ''),                             // Principal Email Address
    val(f.s2PrimaryName || ''),                              // Primary Merchant Contact Name
    val(q.typeOfGoods || f.s3ProductsMcc || ''),             // Products/Services Description
    '',                                                       // Data Field 1
    '',                                                       // Data Field 2
    '',                                                       // Data Field 3
  ];

  rowData.forEach((cellVal, colIdx) => {
    const cellRef = XLSX.utils.encode_cell({ r: dataRow, c: colIdx });
    ws[cellRef] = { t: 's', v: String(cellVal) };
  });

  // Expand sheet range to include new row
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: dataRow, c: rowData.length - 1 },
  });

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generateCustomerDataSheetXlsx };
