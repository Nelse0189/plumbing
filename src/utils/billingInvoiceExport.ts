import * as XLSX from 'xlsx';

export const BILLING_EXPORT_SHAREPOINT_URL =
  'https://1800heaters-my.sharepoint.com/:x:/p/rosie/IQCWhmBaGa8zRYnMfQG7-ugbATPSfDPD8YJepkKUPXrBuYM?e=OoXOqe';

export interface BillingExportMaterial {
  description: string;
  amount: string;
}

export interface BillingExportTicket {
  id: string;
  status: 'draft' | 'signed';
  workOrderNumber: string;
  customerName: string;
  city: string;
  serviceDate: string;
  jobType: string;
  workPerformed: string;
  heaterModel: string;
  heaterPrice: string;
  permitAmount: string;
  laborAmount: string;
  totalAmount: string;
  materials: BillingExportMaterial[];
  extraCharges: BillingExportMaterial[];
  signedAt?: string;
  plumberName: string;
}

export interface BillingExportLinePreview {
  id: string;
  workOrderNumber: string;
  customerName: string;
  town: string;
  workPerformed: string;
  laborAmount: number;
  extrasAmount: number;
  waterHeaterFee: number;
  panFee: number;
  total: number;
  status: string;
  reason: string;
}

export interface BillingExportWorkbook {
  fileName: string;
  bytes: Uint8Array;
  included: BillingExportLinePreview[];
  skipped: BillingExportLinePreview[];
}

export function easternDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function parseMoney(value: string | number | undefined | null): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }
  const text = String(value || '').trim();
  if (!text) return 0;
  const parenNegative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '$1');
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return 0;
  return Math.round((parenNegative ? -Math.abs(amount) : amount) * 100) / 100;
}

function lineAmount(row: BillingExportMaterial): number {
  return parseMoney(row.amount);
}

function isPanLine(row: BillingExportMaterial): boolean {
  return /\bpan\b/i.test(row.description || '');
}

function workLabel(ticket: BillingExportTicket): string {
  const notes = (ticket.workPerformed || '').replace(/\s+/g, ' ').trim();
  return (
    ticket.jobType.trim() ||
    ticket.heaterModel.trim() ||
    notes.slice(0, 80) ||
    'Completed job'
  );
}

export function ticketToInvoiceLine(ticket: BillingExportTicket): BillingExportLinePreview {
  const lines = [...ticket.materials, ...ticket.extraCharges].filter(
    (row) => row.description.trim() || parseMoney(row.amount)
  );
  const panFee = Math.round(lines.filter(isPanLine).reduce((sum, row) => sum + lineAmount(row), 0) * 100) / 100;
  const extrasAmount =
    Math.round(
      (lines.filter((row) => !isPanLine(row)).reduce((sum, row) => sum + lineAmount(row), 0) +
        parseMoney(ticket.permitAmount)) *
        100
    ) / 100;
  const laborAmount = parseMoney(ticket.laborAmount);
  const waterHeaterFee = parseMoney(ticket.heaterPrice);
  const listedTotal = parseMoney(ticket.totalAmount);
  const computed = Math.round((laborAmount + extrasAmount + waterHeaterFee + panFee) * 100) / 100;
  return {
    id: ticket.id,
    workOrderNumber: ticket.workOrderNumber,
    customerName: ticket.customerName,
    town: ticket.city,
    workPerformed: workLabel(ticket),
    laborAmount,
    extrasAmount,
    waterHeaterFee,
    panFee,
    total: listedTotal || computed,
    status: ticket.status,
    reason:
      ticket.status === 'signed'
        ? 'Signed / completed'
        : 'Draft — not added to the invoice sheet',
  };
}

function invoiceHeaderRows(serviceDate: string): unknown[][] {
  return [
    ['N&J Plumbing LLC — Invoice'],
    ['TEST COPY — live SharePoint workbook was not changed'],
    ['', '', '', '', `TEST-${serviceDate}`, serviceDate],
    [],
    ['', '', '', '', 'Terms', 'Due on receipt'],
    [],
    ['Bill To'],
    ['1-800 Heaters'],
    [],
    [
      'Date',
      'Order #',
      'Name',
      'Town',
      'Work Performed',
      'Labor',
      'Extras',
      'W/H Fee',
      'Pan Fee',
      'Total',
      'Notes',
    ],
  ];
}

function completedRows(lines: BillingExportLinePreview[], serviceDate: string): unknown[][] {
  return lines.map((line) => [
    serviceDate,
    line.workOrderNumber,
    line.customerName,
    line.town,
    line.workPerformed,
    line.laborAmount || '',
    line.extrasAmount || '',
    line.waterHeaterFee || '',
    line.panFee || '',
    line.total || '',
    line.status === 'signed' ? 'Completed job ticket' : line.reason,
  ]);
}

function reviewRows(tickets: BillingExportTicket[], lines: BillingExportLinePreview[]): unknown[][] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  return [
    [
      'Included',
      'Ticket ID',
      'Work order',
      'Customer',
      'Town',
      'Service date',
      'Status',
      'Signed at',
      'Plumber',
      'Work',
      'Total',
      'Reason',
    ],
    ...tickets.map((ticket) => {
      const line = byId.get(ticket.id);
      return [
        ticket.status === 'signed' ? 'Yes' : 'No',
        ticket.id,
        ticket.workOrderNumber,
        ticket.customerName,
        ticket.city,
        ticket.serviceDate,
        ticket.status,
        ticket.signedAt || '',
        ticket.plumberName,
        line?.workPerformed || workLabel(ticket),
        line?.total ?? '',
        line?.reason || '',
      ];
    }),
  ];
}

export function buildCompletedJobsWorkbook(
  tickets: BillingExportTicket[],
  options: {
    serviceDate: string;
    sharePointUrl?: string;
  }
): BillingExportWorkbook {
  const { serviceDate } = options;
  const sharePointUrl = options.sharePointUrl || BILLING_EXPORT_SHAREPOINT_URL;
  const lines = tickets.map(ticketToInvoiceLine);
  const included = lines.filter((line) => line.status === 'signed');
  const skipped = lines.filter((line) => line.status !== 'signed');

  const invoiceSheet = XLSX.utils.aoa_to_sheet([
    ...invoiceHeaderRows(serviceDate),
    ...completedRows(included, serviceDate),
    [],
    ['Source workbook (not edited)', sharePointUrl],
    ['This file is a test export of completed job tickets only.'],
  ]);
  invoiceSheet['!cols'] = [
    { wch: 12 },
    { wch: 14 },
    { wch: 22 },
    { wch: 16 },
    { wch: 28 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 22 },
  ];

  const reviewSheet = XLSX.utils.aoa_to_sheet([
    ['N&J Plumbing ticket review — do not bill from this sheet'],
    [`Service date (America/New_York): ${serviceDate}`],
    ['Live SharePoint invoice book was not opened for writing.'],
    [sharePointUrl],
    [],
    ...reviewRows(tickets, lines),
  ]);
  reviewSheet['!cols'] = [
    { wch: 10 },
    { wch: 22 },
    { wch: 14 },
    { wch: 22 },
    { wch: 16 },
    { wch: 12 },
    { wch: 10 },
    { wch: 22 },
    { wch: 16 },
    { wch: 28 },
    { wch: 10 },
    { wch: 36 },
  ];

  const workbook = XLSX.utils.book_new();
  const invoiceName = `Completed ${serviceDate}`.slice(0, 31);
  XLSX.utils.book_append_sheet(workbook, invoiceSheet, invoiceName);
  XLSX.utils.book_append_sheet(workbook, reviewSheet, 'Review');

  const raw = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array | number[];
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : Uint8Array.from(raw);
  return {
    fileName: `NJ-completed-jobs-${serviceDate}.xlsx`,
    bytes,
    included,
    skipped,
  };
}
