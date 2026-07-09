const PDFDocument = require('pdfkit');

const LOGO = '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';

function money(n){ return Math.round(Number(n||0)*100)/100; }
function usd(n){ return '$'+money(n).toFixed(2); }
function bs(n){ return 'Bs. '+money(n).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function text(v){ return String(v ?? ''); }

function buildReceiptPdf(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36, autoFirstPage: true, info: { Title: 'Comprobante de Pago' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const W = doc.page.width, H = doc.page.height, M = 44;
    const green = '#0b2f16', pink = '#d9426b', line = '#d9e3d9', light = '#f6f8f6';
    const logoBuffer = Buffer.from(LOGO, 'base64');

    doc.image(logoBuffer, (W-88)/2, 30, { width: 88 });
    doc.fillColor(green).font('Helvetica-Bold').fontSize(15).text('COMPROBANTE DE PAGO', M, 130, { width: W-2*M, align: 'center' });
    doc.fillColor('#555555').font('Helvetica').fontSize(8.5).text('Urbanización Villa Los Apamates', M, 150, { width: W-2*M, align: 'center' });
    doc.moveTo(M, 174).lineTo(W-M, 174).strokeColor(pink).lineWidth(1).stroke();

    doc.fillColor(green).font('Helvetica-Bold').fontSize(8.5).text('Nro. Comprobante:', M, 194);
    doc.fillColor('#111111').font('Helvetica').fontSize(8.5).text(text(payload.receiptNumber), M+92, 194, { width: 190 });
    doc.fillColor(green).font('Helvetica-Bold').text('Fecha:', W-M-115, 194);
    doc.fillColor('#111111').font('Helvetica').text(text(payload.date), W-M-72, 194, { width: 72, align: 'right' });

    const rows = [
      ['Casa', text(payload.casa)],
      ['Propietario', text(payload.ownerName || 'Propietario')],
      ['Forma de pago', text(payload.mode || payload.formaPago)],
      ['Referencia', text(payload.reference || 'N/A')],
      ['Monto USD Ref.', usd(payload.amountUsd)],
      ['Monto Bs.', Number(payload.amountBs||0)>0 ? bs(payload.amountBs) : 'N/A'],
      ['Concepto', text(payload.concept || 'Pago registrado en el sistema administrativo')]
    ];

    let y = 224, labelW = 132, rowH = 31;
    doc.rect(M, y, W-2*M, rowH*rows.length).strokeColor(line).lineWidth(0.7).stroke();
    rows.forEach((r,i) => {
      const yy = y + i*rowH;
      doc.rect(M, yy, labelW, rowH).fillColor(light).fill();
      doc.moveTo(M, yy+rowH).lineTo(W-M, yy+rowH).strokeColor(line).lineWidth(0.35).stroke();
      doc.fillColor(green).font('Helvetica-Bold').fontSize(9).text(r[0], M+10, yy+10, { width: labelW-20, height: rowH-8 });
      doc.fillColor('#111111').font('Helvetica').fontSize(9).text(r[1], M+labelW+10, yy+10, { width: W-2*M-labelW-20, height: rowH-8, ellipsis: true });
    });

    y += rowH*rows.length + 22;
    doc.roundedRect(M, y, W-2*M, 58, 7).strokeColor(line).fillAndStroke('#fbfcfb', line);
    doc.fillColor('#555555').font('Helvetica').fontSize(8)
      .text('Este comprobante confirma que el pago fue registrado en el sistema administrativo de la Urbanización Villa Los Apamates. Si observa alguna diferencia, por favor comuníquese con la administración.', M+16, y+13, { width: W-2*M-32, align: 'left' });

    doc.moveTo(M, H-74).lineTo(W-M, H-74).strokeColor(line).lineWidth(0.5).stroke();
    doc.fillColor('#777777').font('Helvetica').fontSize(7.5)
      .text('Documento generado automáticamente por el portal administrativo.', M, H-62, { width: W-2*M, align: 'center', lineBreak: false });
    doc.end();
  });
}

module.exports = { buildReceiptPdf };
