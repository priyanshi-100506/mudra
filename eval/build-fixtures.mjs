/**
 * Generates the eval fixtures and their ground truth from one source.
 *
 * The two are produced together on purpose. A ground-truth file maintained by
 * hand alongside hand-written fixtures drifts within a week — someone edits a
 * number in a page, the expectation still says the old one, and the harness
 * starts reporting a recall figure that measures nothing. Here the identifier
 * in the page and the expectation in the JSON are the same string.
 *
 * Every identifier is synthetic. The valid ones are constructed to pass their
 * real checksums, and the decoys are constructed to fail them — both verified
 * at generation time, so a fixture cannot silently become the wrong kind of
 * test case.
 */
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

// --- checksums (mirrors of the extension's, used only to build fixtures) ---
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
           [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
           [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
           [9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
           [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
           [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const INV = [0,4,3,2,1,5,6,7,8,9];

const verhoeffOk = (d) => {
  let c = 0;
  [...d].reverse().forEach((ch, i) => { c = D[c][P[i % 8][Number(ch)]]; });
  return c === 0;
};
const verhoeffDigit = (body) => {
  let c = 0;
  [...(body + '0')].reverse().forEach((ch, i) => { c = D[c][P[i % 8][Number(ch)]]; });
  return String(INV[c]);
};
const luhnOk = (s) => {
  const d = s.replace(/\D/g, '');
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return d.length >= 13 && sum % 10 === 0;
};
const luhnDigit = (body) => {
  let sum = 0, alt = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let n = Number(body[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
};

const aadhaar = (body11) => {
  const v = body11 + verhoeffDigit(body11);
  if (!verhoeffOk(v)) throw new Error(`fixture bug: ${v} is not Verhoeff-valid`);
  return v;
};
/** A 12-digit number deliberately built to FAIL Verhoeff. */
const aadhaarDecoy = (body11) => {
  const good = verhoeffDigit(body11);
  const bad = String((Number(good) + 5) % 10);
  const v = body11 + bad;
  if (verhoeffOk(v)) throw new Error(`fixture bug: decoy ${v} accidentally validates`);
  return v;
};
const card = (body15) => {
  const v = body15 + luhnDigit(body15);
  if (!luhnOk(v)) throw new Error(`fixture bug: ${v} is not Luhn-valid`);
  return v;
};
/** A 16-digit number deliberately built to FAIL Luhn. */
const cardDecoy = (body15) => {
  const good = luhnDigit(body15);
  const bad = String((Number(good) + 3) % 10);
  const v = body15 + bad;
  if (luhnOk(v)) throw new Error(`fixture bug: decoy ${v} accidentally validates`);
  return v;
};

// --- the synthetic identifiers every fixture is built from ----------------
// Names are invented. No real person's data appears anywhere in this repo.
const V = {
  aadhaar1: aadhaar('42917583620'),
  aadhaar2: aadhaar('78341209654'),
  aadhaarImg: aadhaar('59023846175'),
  card1: card('452012345678901'),
  card2: card('601100099988877'),
  cardImg: card('411111111111111'),
  pan1: 'BKPPS4321N',
  pan2: 'AFZPK7190H',
  panImg: 'CQWPD5544L',
  upi: 'meera.iyer@okhdfcbank',
  ifsc: 'HDFC0001234',
  passport: 'M8241706',
  phone: '9876543210',
  email: 'meera.iyer@example.test',
  // Decoys — look right, fail their checksum.
  orderNo: aadhaarDecoy('42917583620'),
  ticketNo: cardDecoy('452012345678901'),
  skuPan: 'ZZQRS1234X',        // PAN-shaped, but a warehouse SKU
  invoiceNo: aadhaarDecoy('78341209654'),
  batchNo: cardDecoy('601100099988877'),
};

const page = (title, body, extraHead = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #16181d; }
  header { background: #0b3d91; color: #fff; padding: 18px 32px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  main { max-width: 680px; margin: 32px auto; background: #fff; padding: 28px 32px;
         border: 1px solid #dcdde1; }
  h2 { margin: 0 0 20px; font-size: 19px; font-weight: 500; }
  .row { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  label { width: 200px; text-align: right; font-size: 14px; color: #3c3f47; }
  input, select { flex: 1; padding: 8px 10px; border: 1px solid #c4c6cc; font-size: 14px; }
  button { padding: 9px 22px; background: #0b3d91; color: #fff; border: none; font-size: 14px; }
  .note { margin-top: 20px; font-size: 12px; color: #83868f; }
  .doc { width: 420px; height: 260px; border: 1px solid #c4c6cc; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td, th { padding: 7px 9px; border-bottom: 1px solid #ececef; text-align: left; }
</style>
${extraHead}
</head>
<body>
<header><h1>${title}</h1></header>
<main>
${body}
</main>
<p class="note" style="text-align:center">Synthetic fixture. Every identifier on this page is fake.</p>
</body>
</html>
`;

const field = (id, label, value, attrs = '') =>
  `  <div class="row">
    <label for="${id}">${label}</label>
    <input id="${id}" name="${id}" value="${value}" ${attrs}>
  </div>`;

/**
 * A scanned-document image, drawn as an inline SVG data URI.
 *
 * Generated rather than committed as a PNG for the same reason the rest of
 * this file is generated: the text inside the image and the expectation in
 * the ground truth are then the same string. It also keeps the repo free of
 * binary fixtures that nobody can diff.
 */
const scanSvg = (lines, w = 420, h = 260) => {
  const body = lines.map((l, i) =>
    `<text x="24" y="${54 + i * 34}" font-family="DejaVu Sans, Arial" font-size="${l.size ?? 22}" fill="#111">${l.t}</text>`
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#fdfcf7" stroke="#bbb"/>${body}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};

// --- the 15 fixtures ------------------------------------------------------
const fixtures = [];
const add = (id, group, title, html, expect) =>
  fixtures.push({ id, group, title, html, expect });

// Group 1 — DOM-level PII (5)
add('dom-aadhaar', 'dom-pii', 'UIDAI — Update Aadhaar Details',
  `<h2>Verify your identity</h2>
${field('aadhaar_number', 'Aadhaar number', V.aadhaar1)}
${field('full_name', 'Name as on Aadhaar', 'Meera Iyer')}
${field('otp', 'OTP sent to your mobile', '', 'type="tel" autocomplete="one-time-code"')}
  <button>Verify</button>`,
  { pii: [V.aadhaar1], decoys: [] });

add('dom-pan', 'dom-pii', 'Income Tax — e-Filing Portal',
  `<h2>File your return</h2>
${field('pan', 'PAN', V.pan1)}
${field('assessment_year', 'Assessment year', '2025-26')}
${field('password', 'e-Filing password', '', 'type="password"')}
  <button>Continue</button>`,
  { pii: [V.pan1], decoys: [] });

add('dom-card', 'dom-pii', 'Checkout — Payment Details',
  `<h2>Card payment</h2>
${field('card_number', 'Card number', V.card1)}
${field('card_cvv', 'CVV', '', 'type="password"')}
${field('expiry', 'Expiry', '08/29')}
${field('order_reference', 'Order reference', V.orderNo)}
  <button>Pay</button>`,
  // The order reference on the same page is a decoy: it must not be flagged.
  { pii: [V.card1], decoys: [V.orderNo] });

add('dom-upi', 'dom-pii', 'UPI — Send Money',
  `<h2>Send to a UPI ID</h2>
${field('vpa', 'UPI ID', V.upi)}
${field('ifsc', 'Bank IFSC', V.ifsc)}
${field('amount', 'Amount', '2500')}
  <button>Send</button>`,
  { pii: [V.upi, V.ifsc], decoys: [] });

add('dom-passport', 'dom-pii', 'Passport Seva — Application Status',
  `<h2>Track your application</h2>
${field('passport_number', 'Passport number', V.passport)}
${field('applicant_email', 'Email', V.email)}
${field('applicant_mobile', 'Mobile', V.phone, 'type="tel"')}
  <button>Track</button>`,
  { pii: [V.passport, V.email], decoys: [] });

// Group 2 — image-only PII (5)
add('img-aadhaar-scan', 'image-pii', 'KYC Upload — Aadhaar Scan',
  `<h2>Your uploaded document</h2>
  <img class="doc" alt="Uploaded document" src="${scanSvg([
    { t: 'GOVERNMENT OF INDIA', size: 18 },
    { t: 'Meera Iyer' },
    { t: V.aadhaarImg.replace(/(\d{4})(?=\d)/g, '$1 ') },
    { t: 'DOB: 14/03/1992', size: 18 },
  ])}">
  <p>Uploaded 12 March. Our team will verify within two working days.</p>`,
  { pii: [V.aadhaarImg], decoys: [], imageOnly: true });

add('img-pan-scan', 'image-pii', 'KYC Upload — PAN Card Scan',
  `<h2>Your uploaded PAN card</h2>
  <img class="doc" alt="Uploaded PAN card" src="${scanSvg([
    { t: 'INCOME TAX DEPARTMENT', size: 17 },
    { t: 'Permanent Account Number', size: 17 },
    { t: V.panImg },
    { t: 'Meera Iyer', size: 18 },
  ])}">`,
  { pii: [V.panImg], decoys: [], imageOnly: true });

add('img-card-photo', 'image-pii', 'Support Ticket — Card Photo Attached',
  `<h2>Attachment from customer</h2>
  <img class="doc" alt="Photograph of a card" src="${scanSvg([
    { t: 'DEBIT CARD', size: 17 },
    { t: V.cardImg.replace(/(\d{4})(?=\d)/g, '$1 ') },
    { t: 'VALID THRU 08/29', size: 18 },
    { t: 'MEERA IYER', size: 18 },
  ])}">`,
  { pii: [V.cardImg], decoys: [], imageOnly: true });

add('img-hindi-aadhaar', 'image-pii', 'Aadhaar Scan — Hindi',
  `<h2>आपका दस्तावेज़</h2>
  <img class="doc" alt="Aadhaar card, Hindi" src="${scanSvg([
    { t: 'भारत सरकार', size: 19 },
    { t: 'आधार', size: 19 },
    { t: V.aadhaar2.replace(/(\d{4})(?=\d)/g, '$1 ') },
    { t: 'जन्म तिथि: 14/03/1992', size: 17 },
  ])}">`,
  { pii: [V.aadhaar2], decoys: [], imageOnly: true, devanagari: true });

add('img-face-photo', 'image-pii', 'Video Call — Participant',
  `<h2>Meeting in progress</h2>
  <canvas class="doc" id="stage" width="420" height="260"></canvas>
  <p>One participant has their camera on.</p>`,
  { pii: [], faces: 1, decoys: [], imageOnly: true },
  );

// Group 3 — decoys (5)
// Decoys sit in form fields, not only in prose, so the detector is actually
// asked about them. A decoy in a table cell is never captured into the
// PageIR, which means it tests nothing — the first run of the harness scored
// a column of those as failures before anyone noticed the detector had not
// been consulted.
add('decoy-order-number', 'decoy', 'Shop — Order Confirmation',
  `<h2>Thanks for your order</h2>
${field('order_number', 'Order number', V.orderNo)}
${field('dispatched_on', 'Dispatched', '12 March')}
  <p>Quote order ${V.orderNo} in any correspondence.</p>`,
  { pii: [], decoys: [V.orderNo] });

add('decoy-ticket-number', 'decoy', 'Rail — Ticket Details',
  `<h2>Your ticket</h2>
${field('ticket_number', 'Ticket number', V.ticketNo)}
${field('coach', 'Coach and berth', 'B4 / 32')}`,
  { pii: [], decoys: [V.ticketNo] });

add('decoy-sku-code', 'decoy', 'Warehouse — Stock Item',
  `<h2>Item detail</h2>
${field('sku', 'SKU', V.skuPan)}
${field('batch', 'Batch number', V.batchNo)}
${field('on_hand', 'On hand', '412')}`,
  { pii: [], decoys: [V.skuPan, V.batchNo] });

add('decoy-invoice', 'decoy', 'Billing — Invoice',
  `<h2>Invoice</h2>
  <table>
    <tr><th>Invoice number</th><td>${V.invoiceNo}</td></tr>
    <tr><th>Amount</th><td>₹ 18,400</td></tr>
  </table>
  <p>Payable within 30 days.</p>`,
  { pii: [], decoys: [V.invoiceNo] });

add('decoy-statue-photo', 'decoy', 'Gallery — Stone Statue',
  `<h2>Exhibit 14</h2>
  <img class="doc" alt="Stone statue" src="${scanSvg([
    { t: 'EXHIBIT 14', size: 18 },
    { t: 'Sandstone, 11th century', size: 18 },
    { t: 'Catalogue no. 14-A-221', size: 18 },
  ])}">
  <p>A carved figure. Not a photograph of a person.</p>`,
  // A statue is the false-positive case for a face detector, the way an
  // order number is for a regex.
  { pii: [], decoys: [], faces: 0, imageOnly: true });

// --- write ----------------------------------------------------------------
for (const f of fixtures) {
  writeFileSync(resolve(here, 'fixtures', `${f.id}.html`), page(f.title, f.html));
}

const groundTruth = {
  note:
    'Generated by build-fixtures.mjs. Every identifier is synthetic: the valid ' +
    'ones are constructed to pass their real checksums and the decoys to fail ' +
    'them, both verified at generation time. No real person’s data appears ' +
    'in this repository.',
  generated: new Date().toISOString().slice(0, 10),
  fixtures: fixtures.map((f) => ({
    id: f.id,
    group: f.group,
    title: f.title,
    file: `fixtures/${f.id}.html`,
    /** Values that MUST be detected and sealed. */
    pii: f.expect.pii,
    /** Values that MUST NOT be flagged. This column is the point. */
    decoys: f.expect.decoys,
    /** Faces that must be found, where the fixture has any. */
    faces: f.expect.faces ?? 0,
    /** True when the PII exists only as pixels, so the DOM cannot help. */
    imageOnly: Boolean(f.expect.imageOnly),
    devanagari: Boolean(f.expect.devanagari),
  })),
};

writeFileSync(resolve(here, 'ground-truth.json'), JSON.stringify(groundTruth, null, 2) + '\n');

console.log(`Wrote ${fixtures.length} fixtures and ground-truth.json`);
console.log(`  dom-pii   ${fixtures.filter((f) => f.group === 'dom-pii').length}`);
console.log(`  image-pii ${fixtures.filter((f) => f.group === 'image-pii').length}`);
console.log(`  decoy     ${fixtures.filter((f) => f.group === 'decoy').length}`);
