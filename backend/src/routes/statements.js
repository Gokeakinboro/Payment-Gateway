'use strict';
const router = require('express').Router();
const PDFDocument = require('pdfkit');
const { prisma } = require('../utils/db');
const { requireAuth, requireMerchant, requireCompliance } = require('../middleware/auth');
const { ok, fail, koboToNaira } = require('../utils/helpers');
const { sendEmail, getEmailContent } = require('../services/emailService');

const NAVY  = '#1a2744';
const GREEN = '#7dc534';

function fmt(kobo) {
  return 'NGN ' + (koboToNaira(kobo)).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function buildPDF(doc, merchant, month, txns) {
  const period = new Date(month + '-01').toLocaleDateString('en-GB',{ month:'long', year:'numeric' });
  const W = doc.page.width, CW = W - 80;

  // Header
  doc.rect(0,0,W,72).fill(NAVY);
  doc.fontSize(20).fillColor(GREEN).font('Helvetica-Bold').text('PAYLODE',40,18);
  doc.fontSize(8).fillColor('white').font('Helvetica').text('SERVICES LIMITED',40,42);
  doc.fontSize(9).fillColor('white').text('Monthly Statement  |  ' + period, W-220, 30, {width:180, align:'right'});

  // Merchant block
  doc.y = 90;
  doc.rect(40, doc.y, CW, 68).strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.fontSize(8).fillColor('#64748b').font('Helvetica').text('MERCHANT', 56, doc.y+10);
  doc.fontSize(13).fillColor(NAVY).font('Helvetica-Bold').text(merchant.businessName, 56, doc.y+22);
  doc.fontSize(8).fillColor('#64748b').font('Helvetica').text(merchant.merchantCode + '  |  ' + merchant.category, 56, doc.y+40);
  doc.fontSize(8).fillColor('#64748b').text('Period: ' + period, 56, doc.y+52);
  doc.y += 82;

  // Totals
  const sucTxns = txns.filter(t => t.status === 'SUCCESS');
  const totVol  = sucTxns.reduce((s,t) => s + Number(t.amount), 0n);
  const totFee  = sucTxns.reduce((s,t) => s + Number(t.merchantFee), 0n);
  const totNet  = totVol - totFee;
  const colW    = Math.floor(CW / 3);

  [
    [fmt(totVol), 'Total Collections'],
    [fmt(totFee), 'Processing Fees'],
    [fmt(totNet), 'Net Settlement'],
  ].forEach((col, i) => {
    const x = 40 + i * colW;
    doc.rect(x, doc.y, colW-4, 50).fill(i===2?'#f0fdf4':'#f8fafc');
    doc.fontSize(14).fillColor(i===2?'#166534':NAVY).font('Helvetica-Bold').text(col[0], x+10, doc.y+8, {width:colW-20});
    doc.fontSize(7).fillColor('#64748b').font('Helvetica').text(col[1], x+10, doc.y+30, {width:colW-20});
  });
  doc.y += 62;

  doc.fontSize(8).fillColor('#64748b').font('Helvetica')
     .text(sucTxns.length + ' successful  |  ' + (txns.length - sucTxns.length) + ' failed  |  ' + txns.length + ' total', 40, doc.y);
  doc.y += 20;

  // Table
  if (txns.length === 0) {
    doc.fontSize(10).fillColor('#94a3b8').text('No transactions for this period.', 40, doc.y);
    doc.y += 20;
  } else {
    doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold').text('Transaction Detail', 40, doc.y);
    doc.y += 14;
    const cols = [{w:65,label:'Date'},{w:125,label:'Reference'},{w:65,label:'Channel'},{w:85,label:'Amount'},{w:75,label:'Fee'},{w:60,label:'Status'}];
    doc.rect(40, doc.y, CW, 18).fill('#f1f5f9');
    let x = 44;
    cols.forEach(c => { doc.fontSize(7).fillColor('#475569').font('Helvetica-Bold').text(c.label, x, doc.y+5, {width:c.w}); x += c.w; });
    doc.y += 18;
    txns.slice(0,150).forEach((t, idx) => {
      if (doc.y > doc.page.height - 90) { doc.addPage(); doc.y = 40; }
      if (idx % 2 === 0) doc.rect(40, doc.y, CW, 16).fill('#fafafa');
      x = 44;
      const row = [
        new Date(t.createdAt).toLocaleDateString('en-GB'),
        t.reference.slice(-14),
        t.channel,
        fmt(t.amount),
        fmt(t.merchantFee),
        t.status,
      ];
      const isOk = t.status === 'SUCCESS';
      row.forEach((v, i) => {
        const color = i===5 ? (isOk?'#059669':'#ef4444') : '#374151';
        doc.fontSize(7).fillColor(color).font('Helvetica').text(v, x, doc.y+4, {width:cols[i].w, ellipsis:true});
        x += cols[i].w;
      });
      doc.y += 16;
    });
    if (txns.length > 150) {
      doc.y += 4;
      doc.fontSize(7).fillColor('#94a3b8').text('Showing first 150 of ' + txns.length + ' transactions.', 40, doc.y);
      doc.y += 12;
    }
  }

  // Footer
  const fy = doc.page.height - 44;
  doc.rect(0, fy, W, 44).fill(NAVY);
  doc.fontSize(7).fillColor('rgba(255,255,255,0.55)').font('Helvetica')
     .text('Paylode Services Limited  |  CBN/PAY/2024/001847  |  support@paylodeservices.com', 40, fy+10, {width:W-80, align:'center'});
  doc.fontSize(6).fillColor('rgba(255,255,255,0.35)')
     .text('Electronically generated — valid without signature', 40, fy+24, {width:W-80, align:'center'});
}

async function getData(merchantId, month) {
  const base  = new Date(month + '-01');
  const start = new Date(base.getFullYear(), base.getMonth(), 1);
  const end   = new Date(base.getFullYear(), base.getMonth()+1, 0, 23, 59, 59, 999);
  const [merchant, txns] = await Promise.all([
    prisma.merchant.findUnique({ where:{ id:merchantId } }),
    prisma.transaction.findMany({
      where:{ merchantId, createdAt:{ gte:start, lte:end }, isSandbox:false },
      orderBy:{ createdAt:'asc' },
      select:{ reference:true, amount:true, merchantFee:true, channel:true, status:true, createdAt:true },
    }),
  ]);
  return { merchant, txns, month };
}

// GET /statements/my?month=YYYY-MM
router.get('/my', requireAuth, requireMerchant, async (req, res, next) => {
  try {
    const month = (req.query.month || new Date().toISOString().slice(0,7));
    const d = await getData(req.user.merchant.id, month);
    if (!d.merchant) return fail(res, 'Merchant not found');
    const doc = new PDFDocument({ margin:0, size:'A4', autoFirstPage:true });
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="paylode-statement-${month}.pdf"`);
    doc.pipe(res);
    buildPDF(doc, d.merchant, month, d.txns);
    doc.end();
  } catch(e){ next(e); }
});

// POST /statements/my/email?month=YYYY-MM
router.post('/my/email', requireAuth, requireMerchant, async (req, res, next) => {
  try {
    const month = (req.query.month || new Date().toISOString().slice(0,7));
    const d = await getData(req.user.merchant.id, month);
    if (!d.merchant) return fail(res, 'Merchant not found');
    const period = new Date(month+'-01').toLocaleDateString('en-GB',{ month:'long', year:'numeric' });
    const userRow = await prisma.user.findUnique({ where:{ id:req.user.id }, select:{ email:true } });

    const buffers = [];
    const doc = new PDFDocument({ margin:0, size:'A4', autoFirstPage:true });
    doc.on('data', b => buffers.push(b));
    await new Promise(resolve => { doc.on('end', resolve); buildPDF(doc, d.merchant, month, d.txns); doc.end(); });
    const pdfBuf = Buffer.concat(buffers);

    const email = await getEmailContent('statement_email',
      { merchant_name:d.merchant.businessName, period, statement_month:month },
      `Your Paylode Statement — ${period}`,
      `<p>Dear ${d.merchant.businessName},</p><p>Please find attached your Paylode statement for <strong>${period}</strong>.</p><p>Questions? Email support@paylodeservices.com</p>`
    );
    await sendEmail({
      to: userRow.email,
      subject: email.subject,
      html: email.html,
      attachments: [{ filename:`paylode-statement-${month}.pdf`, content:pdfBuf, contentType:'application/pdf' }],
    });
    ok(res, { sent_to:userRow.email }, 'Statement emailed');
  } catch(e){ next(e); }
});

// GET /statements/:merchantId?month=YYYY-MM  (admin)
router.get('/:merchantId', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const month = (req.query.month || new Date().toISOString().slice(0,7));
    const d = await getData(req.params.merchantId, month);
    if (!d.merchant) return fail(res, 'Merchant not found');
    const doc = new PDFDocument({ margin:0, size:'A4', autoFirstPage:true });
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="stmt-${d.merchant.merchantCode}-${month}.pdf"`);
    doc.pipe(res);
    buildPDF(doc, d.merchant, month, d.txns);
    doc.end();
  } catch(e){ next(e); }
});

module.exports = router;
