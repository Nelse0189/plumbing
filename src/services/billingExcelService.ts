import type { WorkSheet } from 'xlsx';
import type { BillingOrder, WorkOrder, WorkOrderLineItem } from '../types';

export const COMPANY_NAME = 'NJ Plumbing';

export const LINE_CATEGORIES: WorkOrderLineItem['category'][] = [
  'labor',
  'material',
  'trip',
  'other',
];

export function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export function lineAmount(item: WorkOrderLineItem): number {
  return roundMoney(item.quantity * item.unitPrice);
}

export function workOrderSubtotal(workOrder: WorkOrder): number {
  return roundMoney(workOrder.lineItems.reduce((sum, item) => sum + lineAmount(item), 0));
}

export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function nextDocumentNumber(prefix: string, date: string, existing: string[]): string {
  const compactDate = date.replaceAll('-', '');
  const stem = `${prefix}-${compactDate}-`;
  let max = 0;
  for (const value of existing) {
    if (!value.startsWith(stem)) continue;
    const seq = Number.parseInt(value.slice(stem.length), 10);
    if (!Number.isNaN(seq)) max = Math.max(max, seq);
  }
  return `${stem}${String(max + 1).padStart(3, '0')}`;
}

export function buildBillingOrder(
  workOrders: WorkOrder[],
  taxRate: number,
  notes: string,
  existingBillingNumbers: string[] = [],
): BillingOrder {
  const primary = workOrders[0];
  const lineItems = workOrders.flatMap((order) => order.lineItems);
  const subtotal = roundMoney(lineItems.reduce((sum, item) => sum + lineAmount(item), 0));
  const taxAmount = roundMoney(subtotal * (taxRate / 100));
  const createdAt = new Date().toISOString();

  return {
    id: `billing-${Date.now()}`,
    billingOrderNumber: nextDocumentNumber('BO', primary.date, existingBillingNumbers),
    createdAt,
    workOrderNumbers: workOrders.map((order) => order.workOrderNumber),
    customerName: primary.customerName,
    address: primary.address,
    phone: primary.phone,
    jobDate: primary.date,
    lineItems,
    subtotal,
    taxRate,
    taxAmount,
    total: roundMoney(subtotal + taxAmount),
    notes,
  };
}

function categoryLabel(category: WorkOrderLineItem['category']): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function billingSheetRows(order: BillingOrder): (string | number)[][] {
  const rows: (string | number)[][] = [
    [COMPANY_NAME],
    ['Billing Order'],
    [],
    ['Billing Order #', order.billingOrderNumber],
    ['Date', order.jobDate],
    ['Work Order(s)', order.workOrderNumbers.join(', ')],
    [],
    ['Bill To'],
    ['Customer', order.customerName],
    ['Address', order.address],
    ['Phone', order.phone || ''],
    [],
    ['#', 'Description', 'Category', 'Qty', 'Unit Price', 'Amount'],
  ];

  order.lineItems.forEach((item, index) => {
    rows.push([
      index + 1,
      item.description,
      categoryLabel(item.category),
      item.quantity,
      item.unitPrice,
      lineAmount(item),
    ]);
  });

  if (order.lineItems.length === 0) {
    rows.push(['', 'No line items', '', '', '', '']);
  }

  rows.push([]);
  rows.push(['', '', '', '', 'Subtotal', order.subtotal]);
  rows.push(['', '', '', '', `Tax (${order.taxRate}%)`, order.taxAmount]);
  rows.push(['', '', '', '', 'Total', order.total]);
  rows.push([]);
  rows.push(['Notes', order.notes || 'Payment due upon receipt.']);
  rows.push([]);
  rows.push(['Generated', new Date(order.createdAt).toLocaleString()]);

  return rows;
}

function workOrderSheetRows(workOrders: WorkOrder[]): (string | number)[][] {
  const rows: (string | number)[][] = [
    ['Work Order #', 'Date', 'Customer', 'Address', 'Phone', 'Truck', 'Technician', 'Job Description', 'Notes', 'Status'],
  ];

  for (const order of workOrders) {
    rows.push([
      order.workOrderNumber,
      order.date,
      order.customerName,
      order.address,
      order.phone,
      order.truckName || '',
      order.technician || '',
      order.jobDescription,
      order.notes,
      order.status,
    ]);
  }

  rows.push([]);
  rows.push(['Line Items']);
  rows.push(['Work Order #', 'Description', 'Category', 'Qty', 'Unit Price', 'Amount']);

  for (const order of workOrders) {
    for (const item of order.lineItems) {
      rows.push([
        order.workOrderNumber,
        item.description,
        categoryLabel(item.category),
        item.quantity,
        item.unitPrice,
        lineAmount(item),
      ]);
    }
  }

  return rows;
}

function applyColumnWidths(sheet: WorkSheet, widths: number[]): void {
  sheet['!cols'] = widths.map((wch) => ({ wch }));
}

export async function downloadBillingOrderExcel(
  order: BillingOrder,
  sourceWorkOrders: WorkOrder[],
): Promise<void> {
  const XLSX = await import('xlsx');
  const billingSheet = XLSX.utils.aoa_to_sheet(billingSheetRows(order));
  applyColumnWidths(billingSheet, [18, 42, 14, 10, 16, 14]);

  const workOrderSheet = XLSX.utils.aoa_to_sheet(workOrderSheetRows(sourceWorkOrders));
  applyColumnWidths(workOrderSheet, [18, 14, 24, 36, 16, 14, 16, 32, 24, 10]);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, billingSheet, 'Billing Order');
  XLSX.utils.book_append_sheet(workbook, workOrderSheet, 'Work Orders');

  XLSX.writeFile(workbook, `${order.billingOrderNumber}.xlsx`);
}
