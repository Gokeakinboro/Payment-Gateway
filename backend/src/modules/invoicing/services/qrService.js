'use strict';
// QR image generation (PNG data-URL + SVG string) for the scan-to-pay landing page.
const QRCode = require('qrcode');
const { CHECKOUT_BASE } = require('../_shared');

// Public scan target — opens the branded QR pay page, which routes into checkout.
const qrPayUrl = (token) => `${CHECKOUT_BASE}/qr.html?c=${token}`;

// Render any URL as a QR (PNG data-URL + SVG). Used for scan-to-pay QR codes and
// for sharing an invoice as a QR of its hosted invoice.html link.
async function renderQrForUrl(url) {
  const opts = { errorCorrectionLevel: 'M', margin: 1, width: 512 };
  const [pngDataUrl, svg] = await Promise.all([
    QRCode.toDataURL(url, opts),
    QRCode.toString(url, { ...opts, type: 'svg' }),
  ]);
  return { url, pngDataUrl, svg };
}

const renderQr = (token) => renderQrForUrl(qrPayUrl(token));

module.exports = { renderQr, renderQrForUrl, qrPayUrl };
