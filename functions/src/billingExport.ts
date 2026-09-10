import * as admin from "firebase-admin";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as XLSX from "xlsx";

export const BILLING_EXPORT_SHAREPOINT_URL =
  "https://1800heaters-my.sharepoint.com/:x:/p/rosie/IQCWhmBaGa8zRYnMfQG7-ugbATPSfDPD8YJepkKUPXrBuYM?e=OoXOqe";

interface TicketInput {
  id: string;
  status: "draft" | "signed";
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
  materials: { description: string; amount: string }[];
  extraCharges: { description: string; amount: string }[];
  signedAt?: string;
  plumberName: string;
}

interface LinePreview {
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

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stamp(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && "toDate" in value) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
}

function materialsFrom(value: unknown): { description: string; amount: string }[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      description: asText(item.description),
      amount: asText(item.amount),
    };
  });
}

export function easternDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parseMoney(value: string | number | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }
  const text = String(value || "").trim();
  if (!text) return 0;
  const parenNegative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "$1");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return 0;
  return Math.round((parenNegative ? -Math.abs(amount) : amount) * 100) / 100;
}

function isPanLine(row: { description: string; amount: string }): boolean {
  return /\bpan\b/i.test(row.description || "");
}

function workLabel(ticket: TicketInput): string {
  const notes = (ticket.workPerformed || "").replace(/\s+/g, " ").trim();
  return ticket.jobType.trim() || ticket.heaterModel.trim() || notes.slice(0, 80) || "Completed job";
}

function ticketToLine(ticket: TicketInput): LinePreview {
  const lines = [...ticket.materials, ...ticket.extraCharges].filter(
    (row) => row.description.trim() || parseMoney(row.amount)
  );
  const panFee =
    Math.round(lines.filter(isPanLine).reduce((sum, row) => sum + parseMoney(row.amount), 0) * 100) /
    100;
  const extrasAmount =
    Math.round(
      (lines.filter((row) => !isPanLine(row)).reduce((sum, row) => sum + parseMoney(row.amount), 0) +
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
      ticket.status === "signed"
        ? "Signed / completed"
        : "Draft — not added to the invoice sheet",
  };
}

function serializeTicket(id: string, data: FirebaseFirestore.DocumentData): TicketInput {
  return {
    id,
    status: asText(data.status) === "signed" ? "signed" : "draft",
    workOrderNumber: asText(data.workOrderNumber),
    customerName: asText(data.customerName),
    city: asText(data.city),
    serviceDate: asText(data.serviceDate),
    jobType: asText(data.jobType),
    workPerformed: asText(data.followUpNotes) || asText(data.workPerformed),
    heaterModel: asText(data.heaterModel),
    heaterPrice: asText(data.heaterPrice),
    permitAmount: asText(data.permitAmount),
    laborAmount: asText(data.laborAmount),
    totalAmount: asText(data.totalAmount),
    materials: materialsFrom(data.materials),
    extraCharges: materialsFrom(data.extraCharges),
    signedAt: stamp(data.signedAt),
    plumberName: asText(data.plumberName),
  };
}

function buildWorkbook(tickets: TicketInput[], serviceDate: string) {
  const lines = tickets.map(ticketToLine);
  const included = lines.filter((line) => line.status === "signed");
  const skipped = lines.filter((line) => line.status !== "signed");
  const invoiceRows: unknown[][] = [
    ["N&J Plumbing LLC — Invoice"],
    ["TEST COPY — live SharePoint workbook was not changed"],
    ["", "", "", "", `TEST-${serviceDate}`, serviceDate],
    [],
    ["", "", "", "", "Terms", "Due on receipt"],
    [],
    ["Bill To"],
    ["1-800 Heaters"],
    [],
    [
      "Date",
      "Order #",
      "Name",
      "Town",
      "Work Performed",
      "Labor",
      "Extras",
      "W/H Fee",
      "Pan Fee",
      "Total",
      "Notes",
    ],
    ...included.map((line) => [
      serviceDate,
      line.workOrderNumber,
      line.customerName,
      line.town,
      line.workPerformed,
      line.laborAmount || "",
      line.extrasAmount || "",
      line.waterHeaterFee || "",
      line.panFee || "",
      line.total || "",
      "Completed job ticket",
    ]),
    [],
    ["Source workbook (not edited)", BILLING_EXPORT_SHAREPOINT_URL],
    ["This file is a test export of completed job tickets only."],
  ];
  const reviewRows: unknown[][] = [
    ["N&J Plumbing ticket review — do not bill from this sheet"],
    [`Service date (America/New_York): ${serviceDate}`],
    ["Live SharePoint invoice book was not opened for writing."],
    [BILLING_EXPORT_SHAREPOINT_URL],
    [],
    [
      "Included",
      "Ticket ID",
      "Work order",
      "Customer",
      "Town",
      "Service date",
      "Status",
      "Signed at",
      "Plumber",
      "Work",
      "Total",
      "Reason",
    ],
    ...tickets.map((ticket) => {
      const line = lines.find((item) => item.id === ticket.id);
      return [
        ticket.status === "signed" ? "Yes" : "No",
        ticket.id,
        ticket.workOrderNumber,
        ticket.customerName,
        ticket.city,
        ticket.serviceDate,
        ticket.status,
        ticket.signedAt || "",
        ticket.plumberName,
        line?.workPerformed || workLabel(ticket),
        line?.total ?? "",
        line?.reason || "",
      ];
    }),
  ];

  const invoiceSheet = XLSX.utils.aoa_to_sheet(invoiceRows);
  const reviewSheet = XLSX.utils.aoa_to_sheet(reviewRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, invoiceSheet, `Completed ${serviceDate}`.slice(0, 31));
  XLSX.utils.book_append_sheet(workbook, reviewSheet, "Review");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return {
    fileName: `NJ-completed-jobs-${serviceDate}.xlsx`,
    bytes,
    included,
    skipped,
  };
}

async function loadTicketsForDate(serviceDate: string): Promise<TicketInput[]> {
  const snapshot = await admin
    .firestore()
    .collection("jobTickets")
    .where("serviceDate", "==", serviceDate)
    .get();
  const tickets = snapshot.docs.map((doc) => serializeTicket(doc.id, doc.data()));
  tickets.sort((a, b) => {
    const byName = a.customerName.localeCompare(b.customerName);
    if (byName) return byName;
    return a.workOrderNumber.localeCompare(b.workOrderNumber, undefined, { numeric: true });
  });
  return tickets;
}

async function runExport(serviceDate: string, trigger: "manual" | "schedule") {
  const tickets = await loadTicketsForDate(serviceDate);
  const workbook = buildWorkbook(tickets, serviceDate);
  const fileBase64 = workbook.bytes.toString("base64");
  await admin.firestore().collection("billingExports").add({
    serviceDate,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    trigger,
    fileName: workbook.fileName,
    fileBase64,
    includedCount: workbook.included.length,
    skippedCount: workbook.skipped.length,
    included: workbook.included,
    skipped: workbook.skipped,
    sourceSharePointUrl: BILLING_EXPORT_SHAREPOINT_URL,
    wroteToSharePoint: false,
  });
  return {
    fileName: workbook.fileName,
    fileBase64,
    included: workbook.included,
    skipped: workbook.skipped,
    ticketCount: tickets.length,
  };
}

export const exportCompletedJobTickets = onCall(
  {
    cors: true,
    timeoutSeconds: 60,
    invoker: "public",
    memory: "512MiB",
  },
  async (request) => {
    const requested =
      request.data && typeof request.data === "object"
        ? asText((request.data as { serviceDate?: unknown }).serviceDate)
        : "";
    const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : easternDateKey();
    return runExport(serviceDate, "manual");
  }
);

export const exportCompletedJobTicketsNightly = onSchedule(
  {
    schedule: "0 22 * * *",
    timeZone: "America/New_York",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async () => {
    await runExport(easternDateKey(), "schedule");
  }
);
