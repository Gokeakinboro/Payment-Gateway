'use strict';
// Parallex NIP monitoring report generator
// Run on your laptop after 7am WAT:  node generate-parallex-report.js
// Fetches /var/log/parallex-monitor.json from server 176 and writes an Excel file.

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const SERVER  = 'root@176.57.188.45';
const LOG_SRC = '/var/log/parallex-monitor.json';
const OUT_DIR = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Desktop')
  : '.';

console.log('Fetching log from server 176...');
let raw;
try {
  raw = execSync(`ssh -o BatchMode=yes ${SERVER} "cat ${LOG_SRC}"`, { encoding: 'utf8', timeout: 15000 });
} catch(e) {
  console.error('SSH fetch failed:', e.message);
  process.exit(1);
}

const runs = JSON.parse(raw);
console.log(`Fetched ${runs.length} test runs.`);

// ── Build HTML table (opens perfectly in Excel) ────────────────────────────
const STATUS_COLOR = { SUCCESS: '#c6efce', FETCH_FAILED: '#ffc7ce', NE_FAIL: '#ffeb9c', NE_ERROR: '#ffc7ce', FAIL: '#ffc7ce', PENDING: '#ffeb9c' };

const rows = runs.map((r, i) => {
  const color = STATUS_COLOR[r.status] || '#ffffff';
  const neOk  = r.ne ? (r.ne.ok ? '✅' : '❌') : '—';
  const txOk  = r.status === 'SUCCESS' ? '✅' : r.status === 'PENDING' ? '🔄' : '❌';
  const neMs  = r.ne_duration_ms != null ? r.ne_duration_ms + 'ms' : '—';
  const txMs  = r.transfer_duration_ms != null ? r.transfer_duration_ms + 'ms' : '—';
  const payload = r.transfer_payload ? JSON.stringify(r.transfer_payload.body, null, 2) : '—';
  const rawResp = r.transfer_result ? JSON.stringify(r.transfer_result.raw, null, 2) : (r.error || '—');
  return `
    <tr style="background:${color}">
      <td>${r.run}</td>
      <td>${r.timestamp ? r.timestamp.replace('T',' ').replace('Z',' UTC') : ''}</td>
      <td>N${r.amount_naira}</td>
      <td>${r.ref}</td>
      <td>${neOk} ${neMs}</td>
      <td>${r.ne ? (r.ne.sessionId||'—') : '—'}</td>
      <td>${txOk} ${txMs}</td>
      <td><b>${r.status}</b></td>
      <td>${r.transfer_result ? r.transfer_result.code : '—'}</td>
      <td>${r.transfer_result ? (r.transfer_result.reason||'') : (r.error||'')}</td>
      <td style="font-family:monospace;font-size:10px;white-space:pre;max-width:400px">${payload.replace(/</g,'&lt;')}</td>
      <td style="font-family:monospace;font-size:10px;white-space:pre;max-width:400px">${rawResp.replace(/</g,'&lt;')}</td>
    </tr>`;
}).join('');

const successCount = runs.filter(r => r.status === 'SUCCESS').length;
const failCount    = runs.filter(r => r.status === 'FETCH_FAILED').length;
const neFailCount  = runs.filter(r => r.status?.startsWith('NE')).length;

const html = `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Parallex NIP Monitor</x:Name>
<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 12px; }
  h1   { font-size: 16px; color: #1f3864; }
  h2   { font-size: 13px; color: #2f5496; }
  table { border-collapse: collapse; width: 100%; }
  th   { background: #1f3864; color: white; padding: 6px 10px; text-align: left; border: 1px solid #ccc; }
  td   { padding: 5px 8px; border: 1px solid #ddd; vertical-align: top; }
  .summary { background: #f2f7ff; padding: 12px 16px; border-left: 4px solid #2f5496; margin-bottom: 16px; }
</style>
</head><body>
<h1>Parallex NIP Payout Monitoring Report</h1>
<p>Generated: ${new Date().toISOString().replace('T',' ').replace('Z',' UTC')}</p>
<div class="summary">
  <h2>Summary</h2>
  <p><b>Total runs:</b> ${runs.length} &nbsp;|&nbsp;
     <b style="color:green">Successful:</b> ${successCount} &nbsp;|&nbsp;
     <b style="color:red">NIP Failed (fetch_failed):</b> ${failCount} &nbsp;|&nbsp;
     <b style="color:orange">NE Failed:</b> ${neFailCount}</p>
  <p><b>Endpoint:</b> https://tptintegration.parallexbank.com/ThirdPartyTransferAPI/api/ThirdPartyTransfer/InterbankTransfer</p>
  <p><b>Port:</b> 443 (HTTPS over IPSec VPN) &nbsp;|&nbsp; <b>Our IP:</b> 176.57.188.45</p>
  <p><b>Destination:</b> GTBank 0005061067 (AKINBORO SULAIMON OLAGOKE)</p>
  <p><b>Debit account:</b> 1000362849 &nbsp;|&nbsp; <b>Amounts:</b> N30 → N${runs.length > 0 ? 29 + runs.length : 30} (increments per run)</p>
</div>
<table>
  <thead>
    <tr>
      <th>#</th><th>Timestamp (UTC)</th><th>Amount</th><th>Reference</th>
      <th>Name Enquiry</th><th>NE Session ID</th>
      <th>Transfer</th><th>Status</th><th>Code</th><th>Reason / Error</th>
      <th>Request Payload</th><th>Raw Response</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;

const outFile = path.join(OUT_DIR, 'parallex-nip-report-' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '.xls');
fs.writeFileSync(outFile, html, 'utf8');
console.log('\nReport saved to:', outFile);
console.log('Open it in Excel — it will render as a full spreadsheet.\n');
