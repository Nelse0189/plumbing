import type { JobTicket } from '../types';
import {
  HEATERS_WO_EXTRA_NOTES,
  HEATERS_WO_FIELDS,
  HEATERS_WO_PAGE,
  clampWoFontSize,
  extraNotesValue,
  formatTicketDate,
  workOrderFormImage,
  type PdfBox,
} from './heatersWorkOrder';

const SCALE = 2;

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function jpegPagesToLetterPdf(
  pages: Array<{ jpeg: Uint8Array; width: number; height: number }>
): Uint8Array {
  if (!pages.length) throw new Error('No work orders to print.');
  const encoder = new TextEncoder();
  const header = encoder.encode('%PDF-1.4\n');
  const parts: Uint8Array[] = [header];
  const offsets = [0];
  let offset = header.length;

  const addObject = (bytes: Uint8Array) => {
    offsets.push(offset);
    parts.push(bytes);
    offset += bytes.length;
  };

  const obj = (num: number, body: Uint8Array) =>
    concatBytes([encoder.encode(`${num} 0 obj\n`), body, encoder.encode('\nendobj\n')]);

  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  addObject(obj(1, encoder.encode('<< /Type /Catalog /Pages 2 0 R >>')));
  addObject(
    obj(2, encoder.encode(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`))
  );

  pages.forEach((page, index) => {
    const pageObj = 3 + index * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    addObject(
      obj(
        pageObj,
        encoder.encode(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
        )
      )
    );
    addObject(
      obj(
        imageObj,
        concatBytes([
          encoder.encode(
            `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
          ),
          page.jpeg,
          encoder.encode('\nendstream'),
        ])
      )
    );
    const content = 'q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ\n';
    addObject(
      obj(contentObj, encoder.encode(`<< /Length ${content.length} >>\nstream\n${content}endstream`))
    );
  });

  const xrefStart = offset;
  const objectCount = 2 + pages.length * 3;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objectCount; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(encoder.encode(xref), encoder.encode(trailer));
  return concatBytes(parts);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load the work order form image.'));
    image.src = src;
  });
}

function boxTop(box: PdfBox): number {
  return HEATERS_WO_PAGE.height - box[1] - box[3];
}

function measureTextWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  fallbackEm: number
): number {
  const width = ctx.measureText(text).width;
  if (text && width <= 0) return text.length * fallbackEm * 0.58;
  return width;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fallbackEm: number
): string[] {
  const font = ctx.font;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = font;
    const widthOf = (value: string) => measureTextWidth(ctx, value, fallbackEm);
    const lines: string[] = [];

    const appendChars = (start: string, value: string): string => {
      let line = start;
      for (const char of value) {
        const next = line + char;
        if (line && widthOf(next) > maxWidth) {
          lines.push(line);
          line = char;
        } else {
          line = next;
        }
      }
      return line;
    };

    for (const paragraph of text.split(/\n/)) {
      if (!paragraph) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && widthOf(candidate) > maxWidth) {
          lines.push(line);
          line = widthOf(word) > maxWidth ? appendChars('', word) : word;
        } else if (widthOf(candidate) > maxWidth) {
          line = appendChars(line, word);
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return lines;
  } finally {
    ctx.restore();
  }
}

function drawField(
  ctx: CanvasRenderingContext2D,
  box: PdfBox,
  text: string,
  fontSize: number,
  multiline = false,
  lineHeight?: number
) {
  const value = text.trim();
  if (!value) return;
  const [x, , width, height] = box;
  const top = boxTop(box);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, top, width, height);
  ctx.clip();
  ctx.fillStyle = '#10243a';
  if (multiline) {
    const size = Math.max(6, fontSize);
    ctx.textBaseline = 'top';
    ctx.font = `700 ${size}px "Segoe UI", Helvetica, Arial, sans-serif`;
    const maxWidth = Math.max(8, width - 6);
    const lines = wrapLines(ctx, value, maxWidth, size);
    const step = lineHeight || size + 2;
    lines.forEach((line, index) => {
      if ((index + 1) * step > height) return;
      ctx.fillText(line, x + 3, top + 2 + index * step);
    });
  } else {
    const size = Math.max(6, fontSize - 1);
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${size}px "Segoe UI", Helvetica, Arial, sans-serif`;
    ctx.fillText(value, x + 2, top + height / 2, width - 4);
  }
  ctx.restore();
}

function drawSignature(ctx: CanvasRenderingContext2D, box: PdfBox, image: HTMLImageElement) {
  const [x, , width, height] = box;
  const top = boxTop(box);
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    top + (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  );
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('Could not create the PDF image.'));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      'image/jpeg',
      0.88
    );
  });
}

export function jobTicketPdfFileName(
  ticket: Pick<JobTicket, 'workOrderNumber' | 'customerName' | 'serviceDate'>
): string {
  const wo = ticket.workOrderNumber.replace(/[^\w-]+/g, '') || 'ticket';
  const name =
    ticket.customerName
      .replace(/[^\w]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'customer';
  const date = ticket.serviceDate.replace(/[^\d-]/g, '');
  return `WO-${wo}-${name}${date ? `-${date}` : ''}.pdf`;
}

export function jobTicketsPdfFileName(serviceDate: string, count: number): string {
  const date = serviceDate.replace(/[^\d-]/g, '') || 'jobs';
  return `WO-permits-${date}-${count}.pdf`;
}

async function renderTicketJpeg(
  ticket: Omit<JobTicket, 'id'> & { id?: string },
  suggestedTotal = ''
): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  const canvas = document.createElement('canvas');
  canvas.width = HEATERS_WO_PAGE.width * SCALE;
  canvas.height = HEATERS_WO_PAGE.height * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create the PDF.');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, HEATERS_WO_PAGE.width, HEATERS_WO_PAGE.height);

  const page = await loadImage(workOrderFormImage(ticket.formTemplate));
  ctx.drawImage(page, 0, 0, HEATERS_WO_PAGE.width, HEATERS_WO_PAGE.height);

  const fields = HEATERS_WO_FIELDS;
  const fontSize = clampWoFontSize(ticket.pdfFontSize);
  drawField(ctx, fields.customerName, ticket.customerName, fontSize);
  drawField(ctx, fields.street, ticket.street, fontSize);
  drawField(ctx, fields.city, ticket.city, fontSize);
  drawField(ctx, fields.zip, ticket.zip, fontSize);
  drawField(ctx, fields.phone, ticket.phone, fontSize);
  drawField(ctx, fields.workOrderNumber, ticket.workOrderNumber, fontSize);
  drawField(ctx, fields.followUpNotes, ticket.followUpNotes || ticket.workPerformed, fontSize, true);
  drawField(ctx, fields.serviceDate, formatTicketDate(ticket.serviceDate), fontSize);
  drawField(ctx, fields.plumberName, ticket.plumberName, fontSize);
  drawField(ctx, fields.heaterModel, ticket.heaterModel, fontSize);
  drawField(ctx, fields.heaterPrice, ticket.heaterPrice, fontSize);
  drawField(ctx, fields.serialNumber, ticket.serialNumber, fontSize);
  drawField(ctx, fields.heaterLocation, ticket.heaterLocation, fontSize);
  drawField(ctx, fields.tankWarrantyYears, ticket.tankWarrantyYears, fontSize);
  drawField(ctx, fields.dwellingType, ticket.dwellingType, fontSize);
  fields.additional.forEach((box, index) => {
    drawField(ctx, box, ticket.materials[index]?.description || '', fontSize);
  });
  fields.additionalPrice.forEach((box, index) => {
    drawField(ctx, box, ticket.materials[index]?.amount || '', fontSize);
  });
  drawField(ctx, fields.permitAmount, ticket.permitAmount, fontSize);
  drawField(ctx, fields.totalAmount, ticket.totalAmount || suggestedTotal, fontSize);
  drawField(ctx, fields.paymentMethod, ticket.paymentMethod, fontSize);
  drawField(ctx, fields.driversLicense, ticket.driversLicense, fontSize);
  drawField(ctx, fields.cardOrCheckNumber, ticket.cardOrCheckNumber, fontSize);
  drawField(ctx, fields.routingNumber, ticket.routingNumber, fontSize);
  drawField(ctx, fields.cardExp, ticket.cardExp, fontSize);
  drawField(ctx, fields.amountPaid, ticket.amountPaid, fontSize);
  drawField(
    ctx,
    HEATERS_WO_EXTRA_NOTES,
    extraNotesValue(ticket.extraCharges),
    fontSize,
    true,
    HEATERS_WO_EXTRA_NOTES[3] / fields.extra.length
  );
  fields.extraPrice.forEach((box, index) => {
    drawField(ctx, box, ticket.extraCharges?.[index]?.amount || '', fontSize);
  });

  if (ticket.customerSignature) {
    drawSignature(ctx, fields.customerSignature, await loadImage(ticket.customerSignature));
  }
  if (ticket.customerInitial) {
    drawSignature(ctx, fields.customerInitial, await loadImage(ticket.customerInitial));
  }

  return { jpeg: await canvasToJpeg(canvas), width: canvas.width, height: canvas.height };
}

function downloadPdfBytes(pdf: Uint8Array, fileName: string) {
  const url = pdfObjectUrl(pdf);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function pdfObjectUrl(pdf: Uint8Array): string {
  const copy = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
  return URL.createObjectURL(new Blob([copy as ArrayBuffer], { type: 'application/pdf' }));
}

async function buildJobTicketsPdf(
  tickets: Array<Omit<JobTicket, 'id'> & { id?: string }>,
  suggestedTotals: string[] = []
): Promise<Uint8Array> {
  if (!tickets.length) throw new Error('No work orders to print.');
  const pages = [];
  for (let index = 0; index < tickets.length; index += 1) {
    pages.push(await renderTicketJpeg(tickets[index], suggestedTotals[index] || ''));
  }
  return jpegPagesToLetterPdf(pages);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function buildWorkOrderPrintHtml(pages: Array<{ jpeg: string }>): string {
  const images = pages
    .map(
      (page, index) =>
        `<img src="data:image/jpeg;base64,${page.jpeg}" alt="Work order ${index + 1}" />`
    )
    .join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Print work orders</title>
<style>
  @page { size: letter portrait; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img {
    display: block;
    width: 8.5in;
    height: 11in;
    object-fit: fill;
    page-break-after: always;
    break-after: page;
  }
  img:last-child { page-break-after: auto; break-after: auto; }
  .hint { display: none; }
  @media screen {
    body { background: #1f1c16; }
    .hint {
      display: block;
      color: #f4f1e8;
      padding: 12px 16px;
      font: 14px/1.4 "Segoe UI", sans-serif;
    }
    img { margin: 0 auto 12px; background: #fff; }
  }
</style>
</head>
<body>
<p class="hint">Print preview should open next. If it does not, press Ctrl+P.</p>
${images}
<script>
  function goPrint() {
    window.focus();
    window.print();
  }
  Promise.all(
    Array.from(document.images).map((img) =>
      img.decode ? img.decode().catch(function () {}) : Promise.resolve()
    )
  ).then(function () {
    requestAnimationFrame(function () {
      requestAnimationFrame(goPrint);
    });
  });
  window.addEventListener('afterprint', function () {
    if (location.protocol === 'file:') window.close();
  });
</script>
</body>
</html>`;
}

async function renderPrintPages(
  tickets: Array<Omit<JobTicket, 'id'> & { id?: string }>,
  suggestedTotals: string[] = []
): Promise<Array<{ jpeg: string }>> {
  const pages = [];
  for (let index = 0; index < tickets.length; index += 1) {
    const page = await renderTicketJpeg(tickets[index], suggestedTotals[index] || '');
    pages.push({ jpeg: uint8ToBase64(page.jpeg) });
  }
  return pages;
}

function printHtmlInBrowser(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new Error('Could not open print preview.');
  }
  doc.open();
  doc.write(html);
  doc.close();
  window.setTimeout(() => frame.remove(), 120_000);
}

async function printWorkOrderPages(
  tickets: Array<Omit<JobTicket, 'id'> & { id?: string }>,
  suggestedTotals: string[] = []
): Promise<void> {
  const pages = await renderPrintPages(tickets, suggestedTotals);
  if (!pages.length) throw new Error('No work orders to print.');
  const html = buildWorkOrderPrintHtml(pages);
  if (window.plaudDesktop?.available) {
    if (!window.plaudDesktop.printHtml) {
      throw new Error('Restart the NJ Plumbing desktop app, then print again.');
    }
    await window.plaudDesktop.printHtml(html, 'work-orders');
    return;
  }
  printHtmlInBrowser(html);
}

export async function downloadJobTicketPdf(
  ticket: Omit<JobTicket, 'id'> & { id?: string },
  suggestedTotal = ''
): Promise<void> {
  downloadPdfBytes(await buildJobTicketsPdf([ticket], [suggestedTotal]), jobTicketPdfFileName(ticket));
}

export async function printJobTicketPdf(
  ticket: Omit<JobTicket, 'id'> & { id?: string },
  suggestedTotal = ''
): Promise<void> {
  await printWorkOrderPages([ticket], [suggestedTotal]);
}

export async function downloadJobTicketsPdf(
  tickets: Array<Omit<JobTicket, 'id'> & { id?: string }>,
  fileName: string,
  suggestedTotals: string[] = []
): Promise<void> {
  downloadPdfBytes(await buildJobTicketsPdf(tickets, suggestedTotals), fileName);
}

export async function printJobTicketsPdf(
  tickets: Array<Omit<JobTicket, 'id'> & { id?: string }>,
  _fileName: string,
  suggestedTotals: string[] = []
): Promise<void> {
  await printWorkOrderPages(tickets, suggestedTotals);
}
