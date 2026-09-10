import * as XLSX from 'xlsx';

export const DEFAULT_BILLS_SHAREPOINT_URL =
  'https://1800heaters-my.sharepoint.com/:x:/p/rosie/IQCWhmBaGa8zRYnMfQG7-ugbATPSfDPD8YJepkKUPXrBuYM?e=OoXOqe';

const BILLS_PENDING_KEY = 'njplumbing.bills.sharepoint';

export function setPendingSharePointLoad(url: string) {
  sessionStorage.setItem(BILLS_PENDING_KEY, url);
}

export function takePendingSharePointLoad(): string | null {
  const url = sessionStorage.getItem(BILLS_PENDING_KEY);
  if (!url) return null;
  sessionStorage.removeItem(BILLS_PENDING_KEY);
  return url;
}

export function peekPendingSharePointLoad(): string | null {
  return sessionStorage.getItem(BILLS_PENDING_KEY);
}

export interface BillLine {
  id: string;
  sheet: string;
  row: number;
  date?: string;
  vendor: string;
  category: string;
  description: string;
  invoiceNumber: string;
  amount: number;
  orderNumber?: string;
  town?: string;
  workPerformed?: string;
  laborAmount?: number;
  extrasAmount?: number;
  waterHeaterFee?: number;
  panFee?: number;
  status?: string;
  extra: Record<string, string>;
}

export interface NamedTotal {
  name: string;
  amount: number;
  count: number;
  share: number;
}

export interface MonthlyBucket {
  month: string;
  label: string;
  amount: number;
  count: number;
  unpricedCount: number;
  laborAmount: number;
  extrasAmount: number;
  avgAmount: number;
  projectedAmount?: number;
  projectedCount?: number;
}

export interface YearBucket {
  year: string;
  label: string;
  amount: number;
  count: number;
  unpricedCount: number;
  invoiceCount: number;
  months: MonthlyBucket[];
  isCurrent?: boolean;
  projectedAmount?: number;
  projectedCount?: number;
  monthlyPace?: number;
  projectionNote?: string;
}

export interface YearOverYearMonthRow {
  monthIndex: number;
  monthName: string;
  baseAmount: number;
  compareAmount: number;
  baseCount: number;
  compareCount: number;
  baseProjected?: number;
  compareProjected?: number;
  delta: number;
  deltaPercent: number | null;
}

const CALENDAR_MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function monthBucketForYear(
  byMonth: MonthlyBucket[],
  year: string,
  monthIndex: number
): MonthlyBucket | undefined {
  const key = `${year}-${String(monthIndex).padStart(2, '0')}`;
  return byMonth.find((bucket) => bucket.month === key);
}

export function billYearsFromMonths(byMonth: MonthlyBucket[]): string[] {
  return [...new Set(byMonth.filter((bucket) => /^\d{4}-\d{2}$/.test(bucket.month)).map((bucket) => bucket.month.slice(0, 4)))].sort(
    (left, right) => right.localeCompare(left)
  );
}

export function buildYearOverYearComparison(
  byMonth: MonthlyBucket[],
  compareYear: string,
  baseYear: string,
  useProjectedForCompare = false
): YearOverYearMonthRow[] {
  return CALENDAR_MONTH_NAMES.map((monthName, index) => {
    const monthIndex = index + 1;
    const base = monthBucketForYear(byMonth, baseYear, monthIndex);
    const compare = monthBucketForYear(byMonth, compareYear, monthIndex);
    const baseAmount = base?.amount ?? 0;
    const compareAmount =
      useProjectedForCompare && compare?.projectedAmount != null
        ? compare.projectedAmount
        : compare?.amount ?? 0;
    const delta = Math.round((compareAmount - baseAmount) * 100) / 100;
    const deltaPercent =
      baseAmount !== 0 ? Math.round((delta / baseAmount) * 1000) / 10 : compareAmount !== 0 ? null : 0;
    return {
      monthIndex,
      monthName,
      baseAmount,
      compareAmount,
      baseCount: base?.count ?? 0,
      compareCount: compare?.count ?? 0,
      baseProjected: base?.projectedAmount,
      compareProjected: compare?.projectedAmount,
      delta,
      deltaPercent,
    };
  }).filter((row) => row.baseAmount !== 0 || row.compareAmount !== 0);
}

export interface MonthlyMatrix {
  sheet: string;
  months: string[];
  rows: Array<{ label: string; values: number[]; total: number }>;
}

export interface SheetPreview {
  name: string;
  rows: string[][];
  rowCount: number;
  colCount: number;
}

export interface InvoiceSummary {
  sheet: string;
  invoiceNumber: string;
  invoiceDate?: string;
  billTo: string;
  fromCompany: string;
  terms: string;
  jobCount: number;
  pricedCount: number;
  total: number;
}

export interface BillWorkbookAnalysis {
  fileName: string;
  kind: 'invoice-book' | 'generic';
  sheets: string[];
  lines: BillLine[];
  invoices: InvoiceSummary[];
  fromCompany?: string;
  billTo?: string;
  warnings: string[];
  dateStart?: string;
  dateEnd?: string;
  totalSpend: number;
  totalCredits: number;
  net: number;
  lineCount: number;
  unpricedCount: number;
  avgAmount: number;
  byVendor: NamedTotal[];
  byCategory: NamedTotal[];
  byTown: NamedTotal[];
  byWork: NamedTotal[];
  byMonth: MonthlyBucket[];
  byYear: YearBucket[];
  matrices: MonthlyMatrix[];
  previews: SheetPreview[];
}

const DATE_HEADERS = [
  'date',
  'dated',
  'bill date',
  'invoice date',
  'txn date',
  'trans date',
  'transaction date',
  'due date',
  'paid date',
  'posting date',
];
const AMOUNT_HEADERS = [
  'amount',
  'total',
  'balance',
  'debit',
  'credit',
  'cost',
  'expense',
  'spent',
  'paid',
  'charges',
  'net',
  'subtotal',
];
const VENDOR_HEADERS = [
  'vendor',
  'payee',
  'supplier',
  'name',
  'company',
  'merchant',
  'account name',
  'customer',
];
const CATEGORY_HEADERS = [
  'category',
  'account',
  'type',
  'class',
  'gl',
  'expense',
  'department',
  'job type',
];
const DESCRIPTION_HEADERS = [
  'description',
  'memo',
  'notes',
  'item',
  'details',
  'narrative',
  'product',
  'service',
  'work performed',
];
const INVOICE_HEADERS = [
  'invoice',
  'invoice #',
  'invoice no',
  'bill #',
  'bill no',
  'ref',
  'reference',
  'doc',
  'order #',
  'order no',
];
const SKIP_ROW_LABELS = /^(total|grand total|subtotal|sum|net income|net profit|balance)$/i;
const MONTH_HEADER =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s*[-/]?\s*\d{2,4})?$/i;

function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function normalizeHeader(value: unknown): string {
  return cellText(value).toLowerCase().replace(/\s+/g, ' ').replace(/[:#]/g, '').trim();
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }
  const text = cellText(value);
  if (!text) return undefined;
  if (/^\$?\s*-+\s*$/.test(text) || text === '—' || text === '–') return 0;
  const parenNegative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '$1');
  if (!cleaned || cleaned === '-') return 0;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return undefined;
  const signed = parenNegative || /^-/.test(text) ? -Math.abs(amount) : amount;
  return Math.round(signed * 100) / 100;
}

function excelSerialToIso(serial: number): string | undefined {
  if (serial < 20000 || serial > 80000) return undefined;
  const utc = Date.UTC(1899, 11, 30) + serial * 86400000;
  return new Date(utc).toISOString().slice(0, 10);
}

function parseDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') return excelSerialToIso(value);
  const text = cellText(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  const asNumber = Number(text);
  if (Number.isFinite(asNumber)) return excelSerialToIso(asNumber);
  return undefined;
}

function looksLikeHeader(cell: string): boolean {
  const value = cell.toLowerCase();
  return [
    ...DATE_HEADERS,
    ...AMOUNT_HEADERS,
    ...VENDOR_HEADERS,
    ...CATEGORY_HEADERS,
    ...DESCRIPTION_HEADERS,
    ...INVOICE_HEADERS,
  ].some((header) => value === header || value.includes(header));
}

function isMonthHeader(cell: string): boolean {
  const value = cell.trim();
  if (!value) return false;
  if (MONTH_HEADER.test(value)) return true;
  if (/^\d{4}[-/]\d{1,2}$/.test(value)) return true;
  if (/^\d{1,2}\/\d{4}$/.test(value)) return true;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && /20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(value);
}

function findHeaderRow(rows: unknown[][]): number {
  let bestIndex = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i += 1) {
    const cells = (rows[i] || []).map((cell) => normalizeHeader(cell)).filter(Boolean);
    if (cells.length < 2) continue;
    const headerHits = cells.filter(looksLikeHeader).length;
    const monthHits = cells.filter(isMonthHeader).length;
    const score = headerHits * 3 + monthHits * 2 + Math.min(cells.length, 8);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function bestColumnIndex(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const exact = headers.findIndex((header) => header === candidate);
    if (exact >= 0) return exact;
  }
  for (const candidate of candidates) {
    const partial = headers.findIndex((header) => header.includes(candidate));
    if (partial >= 0) return partial;
  }
  return -1;
}

function inferredCategory(vendor: string, description: string, existing: string): string {
  if (existing) return existing;
  const haystack = `${vendor} ${description}`.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\b(toilet|commode)\b/, 'Toilet'],
    [/\b(labor only|labor)\b/, 'Labor only'],
    [/\b(k&b|kitchen|bath)\b/, 'Kitchen / bath'],
    [/\b(gd|disposal|garbage)\b/, 'Disposal'],
    [/\b(wh|water heater|gs|em|gt|es|g\d|e\d)/i, 'Water heater'],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(haystack)) return label;
  }
  return description ? 'Water heater' : 'Uncategorized';
}

function monthKeyFromDate(iso?: string): string | undefined {
  return iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : undefined;
}

function monthKeyFromHeader(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  const yearMonth = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (yearMonth) return `${yearMonth[1]}-${yearMonth[2].padStart(2, '0')}`;
  const monthYear = text.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYear) return `${monthYear[2]}-${monthYear[1].padStart(2, '0')}`;
  const named = text.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*[-/]?\s*(\d{2,4})$/i
  );
  if (named) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(named[1].slice(0, 3).toLowerCase()) + 1;
    const year = named[2].length === 2 ? 2000 + Number(named[2]) : Number(named[2]);
    if (month > 0 && year >= 2000) return `${year}-${String(month).padStart(2, '0')}`;
  }
  if (!/20\d{2}|19\d{2}/.test(text)) return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return undefined;
  const date = new Date(parsed);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function periodKeyFromLine(line: BillLine): string {
  return (
    monthKeyFromDate(line.date) ||
    monthKeyFromHeader(line.extra.month || '') ||
    monthKeyFromDate(line.extra.invoiceDate) ||
    'Unknown'
  );
}

function monthLabel(key: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) return key;
  const [year, month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function comparePeriodDesc(a: string, b: string): number {
  if (a === 'Unknown' && b === 'Unknown') return 0;
  if (a === 'Unknown') return 1;
  if (b === 'Unknown') return -1;
  return b.localeCompare(a);
}

function toMonthlyBucket(
  month: string,
  value: { amount: number; count: number; unpricedCount: number; laborAmount: number; extrasAmount: number }
): MonthlyBucket {
  return {
    month,
    label: monthLabel(month),
    amount: Math.round(value.amount * 100) / 100,
    count: value.count,
    unpricedCount: value.unpricedCount,
    laborAmount: Math.round(value.laborAmount * 100) / 100,
    extrasAmount: Math.round(value.extrasAmount * 100) / 100,
    avgAmount: value.count ? Math.round((value.amount / value.count) * 100) / 100 : 0,
  };
}

function emptyMonth(month: string): MonthlyBucket {
  return {
    month,
    label: monthLabel(month),
    amount: 0,
    count: 0,
    unpricedCount: 0,
    laborAmount: 0,
    extrasAmount: 0,
    avgAmount: 0,
  };
}

function withCurrentYearProjection(years: YearBucket[]): YearBucket[] {
  const now = new Date();
  const yearKey = String(now.getFullYear());
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), month, 0).getDate();
  const elapsedMonths = Math.max(day / daysInMonth, month - 1 + day / daysInMonth);
  const monthFraction = Math.max(day / daysInMonth, 1 / daysInMonth);
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(now);
  const currentKey = `${yearKey}-${String(month).padStart(2, '0')}`;

  const hasCurrent = years.some((year) => year.year === yearKey);
  const source = hasCurrent
    ? years
    : [
        {
          year: yearKey,
          label: yearKey,
          amount: 0,
          count: 0,
          unpricedCount: 0,
          invoiceCount: 0,
          months: [],
        },
        ...years,
      ];

  return source.map((bucket) => {
    if (bucket.year !== yearKey) return bucket;
    const monthlyPace = elapsedMonths > 0 ? bucket.amount / elapsedMonths : bucket.amount;
    const jobPace = elapsedMonths > 0 ? bucket.count / elapsedMonths : bucket.count;
    const months = bucket.months.map((item) => {
      if (item.month !== currentKey) return item;
      return {
        ...item,
        projectedAmount: Math.round((item.amount / monthFraction) * 100) / 100,
        projectedCount: Math.round(item.count / monthFraction),
      };
    });
    if (!months.some((item) => item.month === currentKey)) {
      months.unshift({
        ...emptyMonth(currentKey),
        projectedAmount: Math.round(monthlyPace * 100) / 100,
        projectedCount: Math.round(jobPace),
      });
    }
    return {
      ...bucket,
      isCurrent: true,
      projectedAmount: Math.round(monthlyPace * 12 * 100) / 100,
      projectedCount: Math.round(jobPace * 12),
      monthlyPace: Math.round(monthlyPace * 100) / 100,
      projectionNote: `${formatUsd(monthlyPace)}/mo pace through ${monthName} ${day}`,
      months,
    };
  });
}

function namedTotals(
  lines: BillLine[],
  pick: (line: BillLine) => string
): NamedTotal[] {
  const spend = lines.reduce((sum, line) => sum + Math.max(0, line.amount), 0) || 1;
  const map = new Map<string, { amount: number; count: number }>();
  for (const line of lines) {
    const name = pick(line) || 'Unknown';
    const current = map.get(name) || { amount: 0, count: 0 };
    current.amount += line.amount;
    current.count += 1;
    map.set(name, current);
  }
  return [...map.entries()]
    .map(([name, value]) => ({
      name,
      amount: Math.round(value.amount * 100) / 100,
      count: value.count,
      share: value.amount / spend,
    }))
    .sort((a, b) => b.count - a.count || Math.abs(b.amount) - Math.abs(a.amount));
}

function sheetToMatrix(_name: string, rows: unknown[][]): unknown[][] {
  return rows.map((row) => {
    const next = [...(row || [])];
    while (next.length && cellText(next[next.length - 1]) === '') next.pop();
    return next;
  });
}

function previewFromRows(name: string, rows: unknown[][]): SheetPreview {
  const trimmed = rows.filter((row) => (row || []).some((cell) => cellText(cell) !== ''));
  const colCount = trimmed.reduce((max, row) => Math.max(max, (row || []).length), 0);
  return {
    name,
    rowCount: trimmed.length,
    colCount,
    rows: trimmed.slice(0, 16).map((row) => {
      const cells: string[] = [];
      for (let i = 0; i < Math.min(colCount, 12); i += 1) {
        cells.push(cellText(row?.[i]));
      }
      return cells;
    }),
  };
}

function findInvoiceHeaderRow(rows: unknown[][]): number {
  return rows.findIndex((row) => {
    const order = normalizeHeader(row?.[1]);
    const name = normalizeHeader(row?.[2]);
    const town = normalizeHeader(row?.[3]);
    return order.includes('order') && name.includes('name') && town.includes('town');
  });
}

function isNjInvoiceSheet(rows: unknown[][]): boolean {
  const blob = rows
    .slice(0, 14)
    .map((row) => (row || []).map((cell) => cellText(cell)).join(' '))
    .join(' ')
    .toLowerCase();
  if (!blob.includes('invoice')) return false;
  return findInvoiceHeaderRow(rows) >= 0;
}

function parseNjInvoiceSheet(sheet: string, rows: unknown[][]): {
  invoice: InvoiceSummary;
  lines: BillLine[];
} | null {
  const headerIndex = findInvoiceHeaderRow(rows);
  if (headerIndex < 0) return null;

  const fromCompany = cellText(rows[0]?.[0]) || 'N&J Plumbing LLC';
  const invoiceNumber = cellText(rows[2]?.[4]) || sheet;
  const invoiceDate = parseDate(rows[2]?.[5]);
  const terms = cellText(rows[4]?.[5]);
  const billTo =
    [6, 7, 8]
      .map((index) => cellText(rows[index]?.[0]))
      .filter(Boolean)
      .join(', ') || cellText(rows[6]?.[0]);

  const lines: BillLine[] = [];
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const orderNumber = cellText(row[1]);
    const customer = cellText(row[2]);
    const date = parseDate(row[0]);
    if (!/^\d+/.test(orderNumber) && !(date && customer)) continue;

    const laborAmount = parseAmount(row[5]) ?? 0;
    const extrasAmount = parseAmount(row[6]) ?? 0;
    const waterHeaterFee = parseAmount(row[7]) ?? 0;
    const panFee = parseAmount(row[8]) ?? 0;
    const listedTotal = parseAmount(row[9]);
    const amount =
      listedTotal && listedTotal !== 0
        ? listedTotal
        : Math.round((laborAmount + extrasAmount + waterHeaterFee + panFee) * 100) / 100;
    const workPerformed = cellText(row[4]);
    const status = [cellText(row[10]), cellText(row[12]), cellText(row[13])]
      .filter((value) => value && !/^\d+$/.test(value))
      .join(' · ');

    lines.push({
      id: `${sheet}-${r}`,
      sheet,
      row: r + 1,
      date,
      vendor: customer || 'Unknown',
      category: inferredCategory(customer, workPerformed, ''),
      description: workPerformed,
      invoiceNumber,
      amount,
      orderNumber,
      town: cellText(row[3]),
      workPerformed,
      laborAmount,
      extrasAmount,
      waterHeaterFee,
      panFee,
      status,
      extra: {
        invoiceDate: invoiceDate || '',
        billTo,
      },
    });
  }

  const total = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  return {
    invoice: {
      sheet,
      invoiceNumber,
      invoiceDate,
      billTo,
      fromCompany,
      terms,
      jobCount: lines.length,
      pricedCount: lines.filter((line) => line.amount > 0).length,
      total,
    },
    lines,
  };
}

function parseMatrixSheet(sheet: string, rows: unknown[][], headerIndex: number): MonthlyMatrix | null {
  const header = (rows[headerIndex] || []).map((cell) => cellText(cell));
  const monthIndexes: number[] = [];
  header.forEach((cell, index) => {
    if (index > 0 && isMonthHeader(cell)) monthIndexes.push(index);
  });
  if (monthIndexes.length < 3) return null;

  const matrixRows: MonthlyMatrix['rows'] = [];
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const label = cellText(rows[r]?.[0]);
    if (!label || SKIP_ROW_LABELS.test(label)) continue;
    const values = monthIndexes.map((index) => parseAmount(rows[r]?.[index]) ?? 0);
    if (values.every((value) => value === 0)) continue;
    matrixRows.push({
      label,
      values,
      total: Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100,
    });
  }
  if (matrixRows.length === 0) return null;
  return {
    sheet,
    months: monthIndexes.map((index) => header[index]),
    rows: matrixRows,
  };
}

function parseTransactionSheet(sheet: string, rows: unknown[][], headerIndex: number): BillLine[] {
  const headerRow = rows[headerIndex] || [];
  const headers = headerRow.map((cell) => normalizeHeader(cell));
  if (headers.filter(Boolean).length < 2) return [];

  const dateIndex = bestColumnIndex(headers, DATE_HEADERS);
  const amountIndex = bestColumnIndex(headers, AMOUNT_HEADERS);
  const vendorIndex = bestColumnIndex(headers, VENDOR_HEADERS);
  const categoryIndex = bestColumnIndex(headers, CATEGORY_HEADERS);
  const descriptionIndex = bestColumnIndex(headers, DESCRIPTION_HEADERS);
  const invoiceIndex = bestColumnIndex(headers, INVOICE_HEADERS);

  const numericFallback =
    amountIndex >= 0
      ? amountIndex
      : headers.reduce((best, _header, index) => {
          let hits = 0;
          for (let r = headerIndex + 1; r < Math.min(rows.length, headerIndex + 12); r += 1) {
            if (parseAmount(rows[r]?.[index]) != null) hits += 1;
          }
          return hits > best.hits ? { index, hits } : best;
        }, { index: -1, hits: 0 }).index;

  if (numericFallback < 0) return [];

  const lines: BillLine[] = [];
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const amount = parseAmount(row[numericFallback]);
    if (amount == null) continue;
    const firstCell = cellText(row[0]);
    if (SKIP_ROW_LABELS.test(firstCell)) continue;

    const extra: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const value = cellText(row[index]);
      if (value) extra[header] = value;
    });

    const vendor = vendorIndex >= 0 ? cellText(row[vendorIndex]) : firstCell;
    const description = descriptionIndex >= 0 ? cellText(row[descriptionIndex]) : '';
    const category = inferredCategory(
      vendor,
      description,
      categoryIndex >= 0 ? cellText(row[categoryIndex]) : ''
    );

    lines.push({
      id: `${sheet}-${r}`,
      sheet,
      row: r + 1,
      date: dateIndex >= 0 ? parseDate(row[dateIndex]) : undefined,
      vendor: vendor || 'Unknown',
      category,
      description,
      invoiceNumber: invoiceIndex >= 0 ? cellText(row[invoiceIndex]) : '',
      amount,
      extra,
    });
  }
  return lines;
}

function flattenMatrix(matrix: MonthlyMatrix): BillLine[] {
  return matrix.rows.flatMap((row, rowIndex) =>
    row.values
      .map((amount, monthIndex) => {
        const monthHeader = matrix.months[monthIndex] || '';
        const month = monthKeyFromHeader(monthHeader);
        return {
          id: `${matrix.sheet}-m-${rowIndex}-${monthIndex}`,
          sheet: matrix.sheet,
          row: rowIndex + 1,
          date: month ? `${month}-01` : undefined,
          vendor: row.label,
          category: row.label,
          description: `${row.label} · ${monthHeader}`,
          invoiceNumber: '',
          amount,
          extra: { month: month || monthHeader },
        };
      })
      .filter((line) => line.amount !== 0)
  );
}

function titleCaseTown(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '(blank)';
  return trimmed
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeWork(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase() || '(blank)';
}

export function formatUsd(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export function analyzeWorkbook(data: ArrayBuffer, fileName: string): BillWorkbookAnalysis {
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });
  const warnings: string[] = [];
  const lines: BillLine[] = [];
  const invoices: InvoiceSummary[] = [];
  const matrices: MonthlyMatrix[] = [];
  const previews: SheetPreview[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rawRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: '',
      blankrows: false,
    }) as unknown[][];
    const rows = sheetToMatrix(sheetName, rawRows);
    if (rows.length === 0) continue;
    previews.push(previewFromRows(sheetName, rows));

    if (isNjInvoiceSheet(rows)) {
      const parsed = parseNjInvoiceSheet(sheetName, rows);
      if (parsed) {
        invoices.push(parsed.invoice);
        lines.push(...parsed.lines);
        continue;
      }
    }

    if (cellText(rows[0]?.[0]).toLowerCase().includes('plumbing')) {
      warnings.push(`Skipped "${sheetName}" because the invoice header was not recognized.`);
      continue;
    }

    const headerIndex = findHeaderRow(rows);
    const matrix = parseMatrixSheet(sheetName, rows, headerIndex);
    if (matrix) {
      matrices.push(matrix);
      lines.push(...flattenMatrix(matrix));
      continue;
    }

    const sheetLines = parseTransactionSheet(sheetName, rows, headerIndex);
    if (sheetLines.length > 0) {
      lines.push(...sheetLines);
    } else {
      warnings.push(`Could not detect bill columns on "${sheetName}". Showing a raw preview.`);
    }
  }

  const dated = lines
    .map((line) => line.date || line.extra.invoiceDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  const totalSpend = lines.filter((line) => line.amount > 0).reduce((sum, line) => sum + line.amount, 0);
  const totalCredits = lines.filter((line) => line.amount < 0).reduce((sum, line) => sum + line.amount, 0);
  const net = lines.reduce((sum, line) => sum + line.amount, 0);
  const monthMap = new Map<
    string,
    { amount: number; count: number; unpricedCount: number; laborAmount: number; extrasAmount: number }
  >();
  for (const line of lines) {
    const key = periodKeyFromLine(line);
    const current = monthMap.get(key) || {
      amount: 0,
      count: 0,
      unpricedCount: 0,
      laborAmount: 0,
      extrasAmount: 0,
    };
    current.amount += line.amount;
    current.count += 1;
    if (line.amount === 0) current.unpricedCount += 1;
    current.laborAmount += line.laborAmount ?? 0;
    current.extrasAmount += line.extrasAmount ?? 0;
    monthMap.set(key, current);
  }

  if (lines.length === 0) {
    warnings.unshift('No jobs or dollar amounts were detected.');
  }

  lines.sort((a, b) => {
    const byPeriod = comparePeriodDesc(periodKeyFromLine(a), periodKeyFromLine(b));
    if (byPeriod) return byPeriod;
    const byDate = (b.date || b.extra.invoiceDate || '').localeCompare(a.date || a.extra.invoiceDate || '');
    if (byDate) return byDate;
    return String(b.invoiceNumber || '').localeCompare(String(a.invoiceNumber || ''), undefined, {
      numeric: true,
    });
  });

  invoices.sort((a, b) => {
    const byDate = (b.invoiceDate || '').localeCompare(a.invoiceDate || '');
    if (byDate) return byDate;
    return String(b.invoiceNumber || '').localeCompare(String(a.invoiceNumber || ''), undefined, {
      numeric: true,
    });
  });

  const byMonth = [...monthMap.entries()]
    .sort(([a], [b]) => comparePeriodDesc(a, b))
    .map(([month, value]) => toMonthlyBucket(month, value));

  const yearMap = new Map<string, YearBucket>();
  for (const bucket of byMonth) {
    const year = /^\d{4}/.test(bucket.month) ? bucket.month.slice(0, 4) : 'Unknown';
    const current = yearMap.get(year) || {
      year,
      label: year === 'Unknown' ? 'Unknown year' : year,
      amount: 0,
      count: 0,
      unpricedCount: 0,
      invoiceCount: 0,
      months: [],
    };
    current.amount = Math.round((current.amount + bucket.amount) * 100) / 100;
    current.count += bucket.count;
    current.unpricedCount += bucket.unpricedCount;
    current.months.push(bucket);
    yearMap.set(year, current);
  }
  for (const invoice of invoices) {
    const year = invoice.invoiceDate?.slice(0, 4) || 'Unknown';
    const current = yearMap.get(year) || {
      year,
      label: year === 'Unknown' ? 'Unknown year' : year,
      amount: 0,
      count: 0,
      unpricedCount: 0,
      invoiceCount: 0,
      months: [],
    };
    current.invoiceCount += 1;
    yearMap.set(year, current);
  }
  const byYear = withCurrentYearProjection(
    [...yearMap.values()].sort((a, b) => comparePeriodDesc(a.year, b.year))
  );
  const currentMonths = new Map(
    (byYear.find((year) => year.isCurrent)?.months || []).map((item) => [item.month, item])
  );
  const monthsWithProjection = byMonth.map((item) => currentMonths.get(item.month) || item);
  if (
    [...currentMonths.values()].some(
      (item) => item.projectedAmount != null && !byMonth.some((month) => month.month === item.month)
    )
  ) {
    const missing = [...currentMonths.values()].filter(
      (item) => item.projectedAmount != null && !byMonth.some((month) => month.month === item.month)
    );
    monthsWithProjection.unshift(...missing);
  }

  return {
    fileName,
    kind: invoices.length > 0 ? 'invoice-book' : 'generic',
    sheets: workbook.SheetNames,
    lines,
    invoices,
    fromCompany: invoices[0]?.fromCompany,
    billTo: invoices[0]?.billTo,
    warnings,
    dateStart: dated[0],
    dateEnd: dated[dated.length - 1],
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
    net: Math.round(net * 100) / 100,
    lineCount: lines.length,
    unpricedCount: lines.filter((line) => line.amount === 0).length,
    avgAmount: lines.length ? Math.round((net / lines.length) * 100) / 100 : 0,
    byVendor: namedTotals(lines, (line) => line.vendor),
    byCategory: namedTotals(lines, (line) => line.category),
    byTown: namedTotals(lines, (line) => titleCaseTown(line.town || '')),
    byWork: namedTotals(lines, (line) => normalizeWork(line.workPerformed || line.description)),
    byMonth: monthsWithProjection,
    byYear,
    matrices,
    previews,
  };
}

export async function analyzeWorkbookFile(file: File): Promise<BillWorkbookAnalysis> {
  const data = await file.arrayBuffer();
  return analyzeWorkbook(data, file.name);
}

export async function downloadWorkbookFromSharingUrl(sharingUrl: string): Promise<{
  name: string;
  data: ArrayBuffer;
}> {
  const proxy = `/__bills_workbook?url=${encodeURIComponent(sharingUrl.trim())}`;
  const response = await fetch(proxy);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Could not download the workbook (${response.status}).`);
  }
  const data = await response.arrayBuffer();
  const bytes = new Uint8Array(data);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('SharePoint returned a web page instead of the Excel file.');
  }
  const name = response.headers.get('x-workbook-name') || 'invoice.xlsx';
  return { name, data };
}
