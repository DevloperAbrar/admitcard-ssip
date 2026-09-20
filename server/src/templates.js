import { config } from './config.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const IST_MS = 5.5 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Exam dates are stored as UTC midnight, so they are formatted in UTC (no timezone shift).
export function formatExamDate(value, withDay = true) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const base = `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withDay ? `${base} (${DAYS[d.getUTCDay()]})` : base;
}

export function formatIstDate(value) {
  const d = new Date(new Date(value).getTime() + IST_MS);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatIstDateTime(value) {
  const d = new Date(new Date(value).getTime() + IST_MS);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getUTCHours();
  return `${formatIstDate(value)}, ${pad2(h % 12 || 12)}:${pad2(d.getUTCMinutes())} ${h >= 12 ? 'PM' : 'AM'}`;
}

/* ------------------------------ Amount in words (Indian system) ------------------------------ */
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(value) {
  let n = value;
  let out = '';
  if (n >= 100) {
    out += `${ONES[Math.floor(n / 100)]} Hundred`;
    n %= 100;
    if (n) out += ' ';
  }
  if (n > 0) {
    if (n < 20) out += ONES[n];
    else {
      out += TENS[Math.floor(n / 10)];
      if (n % 10) out += ` ${ONES[n % 10]}`;
    }
  }
  return out;
}

export function amountInWords(amount) {
  let n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return `${parts.join(' ')} Rupees Only`;
}

/* ------------------------------ Styles ------------------------------ */
const BASE_CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: 'PortalFont','Noto Sans','Segoe UI',Arial,Helvetica,sans-serif; color: #111; font-size: 11px; line-height: 1.35; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.img { background-repeat: no-repeat; background-position: center; background-size: contain; }
.page { position: relative; width: 210mm; height: 296.5mm; padding: 10mm 12mm 8mm; overflow: hidden; break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
.wm { position: absolute; left: 50%; top: 50%; width: 120mm; height: 120mm; margin: -60mm 0 0 -60mm; opacity: 0.06; z-index: 0; }
.sample { position: absolute; left: 0; right: 0; top: 120mm; text-align: center; font-size: 64px; font-weight: 700; letter-spacing: 8px; color: rgba(180,0,0,0.13); transform: rotate(-25deg); z-index: 2; }
.inner { position: relative; z-index: 1; height: 100%; display: flex; flex-direction: column; }
.hdr { display: grid; grid-template-columns: 24mm 1fr 24mm; align-items: center; gap: 4mm; padding-bottom: 3mm; border-bottom: 0.8mm solid var(--accent); }
.hdr .logo { width: 22mm; height: 22mm; }
.hdr .name { text-align: center; font-size: 20px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase; line-height: 1.2; }
.hdr .course { text-align: center; font-size: 12px; font-weight: 600; margin-top: 1.5mm; }
.qrbox { justify-self: end; width: 22mm; }
.qr { width: 22mm; height: 22mm; }
.qr svg { width: 100%; height: 100%; display: block; }
.qrcap { font-size: 6.5px; text-align: center; margin-top: 0.6mm; }
.title { display: flex; justify-content: space-between; align-items: center; margin-top: 3mm; padding: 1.6mm 3mm; border: 0.3mm solid #000; background: #eef2f7; font-weight: 700; }
.title .t { font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; }
.title .s { font-size: 11px; }
.cardno { text-align: right; margin-top: 2mm; font-size: 10px; }
.student { display: flex; gap: 4mm; margin-top: 2mm; align-items: flex-start; }
.details { flex: 1; border-collapse: collapse; }
.details td { border: 0.2mm solid #555; padding: 1.4mm 2mm; vertical-align: top; font-size: 11px; }
.details td.l { width: 22%; background: #f6f7f9; font-weight: 600; }
.photo { width: 30mm; height: 38mm; border: 0.3mm dashed #333; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 9px; color: #444; flex: none; }
.sec { margin-top: 4mm; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
.sched { width: 100%; border-collapse: collapse; margin-top: 1.5mm; }
.sched th, .sched td { border: 0.2mm solid #000; padding: 1.6mm 2mm; font-size: 11px; text-align: left; }
.sched th { background: #dfe6ee; text-align: center; }
.sched td.c { text-align: center; }
.sched tbody tr:nth-child(even) { background: #f1f4f8; }
.ins ol { margin: 1.5mm 0 0; padding-left: 5mm; font-size: 9.5px; line-height: 1.45; }
.grow { flex: 1; }
.sign { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8mm; margin-top: 6mm; align-items: end; }
.sign .box { text-align: center; }
.sign .sig { height: 16mm; }
.sign .line { border-top: 0.25mm solid #000; padding-top: 1mm; font-size: 10px; font-weight: 600; }
.sign .nm { font-size: 9px; font-weight: 400; min-height: 3.5mm; }
.foot { margin-top: 4mm; padding-top: 1.5mm; border-top: 0.25mm solid var(--accent); text-align: center; font-size: 8.5px; color: #333; }
.rcpt-title { text-align: center; margin-top: 4mm; font-size: 15px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
.rcpt { width: 100%; border-collapse: collapse; margin-top: 4mm; }
.rcpt td { border: 0.2mm solid #555; padding: 2mm 3mm; font-size: 11.5px; vertical-align: top; }
.rcpt td.l { width: 30%; background: #f6f7f9; font-weight: 600; }
.amount { font-size: 15px; font-weight: 700; }
.stamp { display: inline-block; margin-top: 4mm; padding: 1mm 4mm; border: 0.5mm solid #166534; color: #166534; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }
.stamp.refunded { border-color: #b91c1c; color: #b91c1c; }
`;

function assetCss(assets) {
  const rules = [];
  for (const [key, uri] of Object.entries(assets || {})) {
    if (uri) rules.push(`.a-${key}{background-image:url("${uri}");}`);
  }
  return rules.join('\n');
}

export function wrapHtml(body, { assets = {}, fontCss = '', accent = config.college.accentColor } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Document</title><style>${fontCss}
:root{--accent:${accent};}
${BASE_CSS}
${assetCss(assets)}</style></head><body>${body}</body></html>`;
}

/* ------------------------------ Admit card ------------------------------ */
export function admitCardPage(d) {
  const rows = d.timetable
    .map(
      (r, i) =>
        `<tr><td class="c">${i + 1}</td><td class="c">${esc(formatExamDate(r.date))}</td><td>${esc(r.subject)}</td><td class="c">${esc(r.time)}</td></tr>`
    )
    .join('');
  const instructions = (d.instructions || []).map((t) => `<li>${esc(t)}</li>`).join('');

  return `
<section class="page">
  <div class="wm img a-logo"></div>
  ${d.sample ? '<div class="sample">PREVIEW</div>' : ''}
  <div class="inner">
    <div class="hdr">
      <div class="logo img a-logo"></div>
      <div>
        <div class="name">${esc(d.collegeName)}</div>
        <div class="course">${esc(d.courseTitle)}</div>
      </div>
      <div class="qrbox"><div class="qr">${d.qrSvg}</div><div class="qrcap">Scan to verify</div></div>
    </div>

    <div class="title">
      <span class="t">${esc(d.examTitle)}</span>
      <span class="s">Academic Session: ${esc(d.session)}</span>
    </div>
    <div class="cardno">Card No.: <b>${esc(d.cardNo)}</b></div>

    <div class="student">
      <table class="details">
        <tr><td class="l">Name</td><td>${esc(d.student.name)}</td><td class="l">Enrollment No.</td><td>${esc(d.student.enrollmentNo)}</td></tr>
        <tr><td class="l">Roll No.</td><td>${esc(d.student.rollNo)}</td><td class="l">Year / Semester</td><td>Year ${esc(d.year)} / Semester ${esc(d.semester)}</td></tr>
        <tr><td class="l">Examination</td><td>${esc(d.examName)}</td><td class="l">Course</td><td>${esc(d.courseShort)}</td></tr>
      </table>
      <div class="photo">Affix<br/>Photo</div>
    </div>

    <div class="sec">Examination Schedule</div>
    <table class="sched">
      <thead><tr><th style="width:9%">S.No</th><th style="width:27%">Date</th><th>Subject</th><th style="width:20%">Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    ${instructions ? `<div class="ins"><div class="sec">Instructions</div><ol>${instructions}</ol></div>` : ''}

    <div class="grow"></div>

    <div class="sign">
      <div class="box"><div class="sig img a-inchargeSign"></div><div class="line">Exam In-charge</div><div class="nm">${esc(d.inchargeName)}</div></div>
      <div class="box"><div class="sig img a-seal"></div><div class="line">Office Seal</div><div class="nm">&nbsp;</div></div>
      <div class="box"><div class="sig img a-principalSign"></div><div class="line">Principal</div><div class="nm">${esc(d.principalName)}</div></div>
    </div>

    <div class="foot">Computer-generated admit card &bull; Generated on ${esc(formatIstDate(d.generatedOn))} &bull; Scan the QR code to verify authenticity</div>
  </div>
</section>`;
}

/* ------------------------------ Receipt ------------------------------ */
export function receiptPage(d) {
  const refunded = d.status === 'refunded';
  return `
<section class="page">
  <div class="wm img a-logo"></div>
  <div class="inner">
    <div class="hdr">
      <div class="logo img a-logo"></div>
      <div>
        <div class="name">${esc(d.collegeName)}</div>
        <div class="course">${esc(d.courseName)}</div>
      </div>
      <div></div>
    </div>

    <div class="rcpt-title">Fee Receipt</div>

    <table class="rcpt">
      <tr><td class="l">Receipt No.</td><td>${esc(d.receiptNo)}</td><td class="l">Date</td><td>${esc(formatIstDateTime(d.paidAt))}</td></tr>
      <tr><td class="l">Student Name</td><td>${esc(d.student.name)}</td><td class="l">Enrollment No.</td><td>${esc(d.student.enrollmentNo)}</td></tr>
      <tr><td class="l">Roll No.</td><td>${esc(d.student.rollNo)}</td><td class="l">Course</td><td>${esc(d.courseShort)}</td></tr>
      <tr><td class="l">Semester</td><td>${esc(d.semester)}</td><td class="l">Academic Session</td><td>${esc(d.session)}</td></tr>
      <tr><td class="l">Description</td><td colspan="3">${esc(d.description)}</td></tr>
      <tr><td class="l">Amount Paid</td><td colspan="3"><span class="amount">&#8377; ${esc(Number(d.amount).toLocaleString('en-IN'))}</span><br/>${esc(amountInWords(d.amount))}</td></tr>
      <tr><td class="l">Payment Method</td><td>${esc(d.method)}</td><td class="l">Transaction Ref.</td><td>${esc(d.reference)}</td></tr>
      ${d.orderId ? `<tr><td class="l">Order ID</td><td colspan="3">${esc(d.orderId)}</td></tr>` : ''}
      ${
        refunded
          ? `<tr><td class="l">Refund</td><td colspan="3">&#8377; ${esc(Number(d.refundAmount || d.amount).toLocaleString('en-IN'))} refunded on ${esc(formatIstDate(d.refundedAt))}</td></tr>`
          : ''
      }
    </table>

    <div><span class="stamp ${refunded ? 'refunded' : ''}">${refunded ? 'Refunded' : 'Paid'}</span></div>

    <div class="grow"></div>
    <div class="foot">Computer-generated receipt &bull; Generated on ${esc(formatIstDate(d.generatedOn))} &bull; No signature required</div>
  </div>
</section>`;
}