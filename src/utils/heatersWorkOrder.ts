import type { CSSProperties } from 'react';

/** Letter-size 1-800 Heaters work order. PDF origin is bottom-left. */
export const HEATERS_WO_PAGE = { width: 612, height: 792 };
export const HEATERS_WO_URL = '/heaters-wo-2023.pdf';
export const HEATERS_WO_IMAGE = '/heaters-wo-2023.png?v=ct-plm-0289267';
export const NJ_WO_IMAGE = '/nj-plumbing-wo.png?v=nj-plm-only';

export type WorkOrderFormTemplate = 'heaters' | 'nj';

export function workOrderFormImage(template: WorkOrderFormTemplate | undefined): string {
  return template === 'heaters' ? HEATERS_WO_IMAGE : NJ_WO_IMAGE;
}

export type PdfBox = [x: number, y: number, w: number, h: number];

export const DEFAULT_WO_FONT_SIZE = 11;
export const MIN_WO_FONT_SIZE = 7;
export const MAX_WO_FONT_SIZE = 16;

export function clampWoFontSize(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WO_FONT_SIZE;
  return Math.min(MAX_WO_FONT_SIZE, Math.max(MIN_WO_FONT_SIZE, Math.round(parsed)));
}

export function pdfBoxStyle(box: PdfBox): CSSProperties {
  const [x, y, w, h] = box;
  return {
    left: `${(x / HEATERS_WO_PAGE.width) * 100}%`,
    top: `${((HEATERS_WO_PAGE.height - y - h) / HEATERS_WO_PAGE.height) * 100}%`,
    width: `${(w / HEATERS_WO_PAGE.width) * 100}%`,
    height: `${(h / HEATERS_WO_PAGE.height) * 100}%`,
  };
}

const US_STATE =
  '(?:A[LKZR]|C[AOT]|D[EC]|F[LM]|G[AU]|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])';

const STREET_SUFFIX =
  '(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|blvd|boulevard|court|ct|way|terrace|ter|place|pl|circle|cir|parkway|pkwy|highway|hwy|trail|trl)';

function normalizeAddress(address: string): string {
  return address
    .replace(/[\n\r]+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*,+/g, ', ')
    .trim()
    .replace(/[,\s]+$/, '');
}

function cityWithState(city: string, state: string): string {
  const name = city.trim().replace(/[,\s]+$/, '');
  const st = state.trim().toUpperCase();
  if (!name) return st;
  const existing = name.match(new RegExp(`^(.*?)(?:,\\s+|\\s+)(${US_STATE})$`, 'i'));
  if (existing) {
    const cityName = existing[1].trim();
    return cityName ? `${cityName}, ${existing[2].toUpperCase()}` : existing[2].toUpperCase();
  }
  return `${name}, ${st}`;
}

function splitStreetAndCity(value: string): { street: string; city: string } {
  const text = value.trim();
  if (!text) return { street: '', city: '' };

  const comma = text.match(/^(.*),\s*([^,]+)$/);
  if (comma && !/^(?:apt|apartment|unit|ste|suite|#)\b/i.test(comma[2])) {
    return { street: comma[1].trim(), city: comma[2].trim() };
  }

  const afterSuffix = text.match(
    new RegExp(`^(.*\\b${STREET_SUFFIX}\\.?)\\s+(.+)$`, 'i')
  );
  if (afterSuffix) {
    return { street: afterSuffix[1].trim(), city: afterSuffix[2].trim() };
  }

  return { street: text, city: '' };
}

export function parseJobAddress(address: string): { street: string; city: string; zip: string } {
  const trimmed = normalizeAddress(address);
  if (!trimmed) return { street: '', city: '', zip: '' };

  const zipMatch = trimmed.match(/\s+(\d{5}(?:-\d{4})?)$/);
  const zip = zipMatch?.[1] || '';
  const withoutZip = zip
    ? trimmed.slice(0, -zip.length).trim().replace(/[,\s]+$/, '')
    : trimmed;

  const withCommaState = withoutZip.match(new RegExp(`^(.*),\\s*(${US_STATE})$`, 'i'));
  if (withCommaState) {
    const parts = splitStreetAndCity(withCommaState[1]);
    return {
      street: parts.street,
      city: cityWithState(parts.city, withCommaState[2]),
      zip,
    };
  }

  const withState = withoutZip.match(new RegExp(`^(.*?)\\s+(${US_STATE})$`, 'i'));
  if (withState) {
    const parts = splitStreetAndCity(withState[1]);
    return {
      street: parts.street,
      city: cityWithState(parts.city, withState[2]),
      zip,
    };
  }

  if (zip) {
    const parts = splitStreetAndCity(withoutZip);
    return { street: parts.street, city: parts.city, zip };
  }

  return { street: trimmed, city: '', zip: '' };
}

export function combinedAddress(street: string, city: string, zip: string): string {
  return [street, city, zip].map((part) => part.trim()).filter(Boolean).join(', ');
}

export function formatTicketDate(value: string): string {
  if (!value) return '';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[2]}/${match[3]}/${match[1]}`;
  return value;
}

export function parseTicketDate(value: string): string {
  const slash = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  return value;
}

export const HEATERS_WO_FIELDS = {
  customerName: [78, 636, 305, 20] as PdfBox,
  street: [80, 615, 303, 16] as PdfBox,
  city: [68, 595, 175, 16] as PdfBox,
  zip: [292, 595, 90, 16] as PdfBox,
  phone: [92, 575, 290, 16] as PdfBox,
  workOrderNumber: [398, 646, 178, 14] as PdfBox,
  followUpNotes: [394, 574, 186, 70] as PdfBox,
  serviceDate: [478, 738, 100, 18] as PdfBox,
  plumberName: [478, 710, 100, 18] as PdfBox,
  heaterModel: [78, 532, 118, 16] as PdfBox,
  heaterPrice: [512, 532, 66, 16] as PdfBox,
  serialNumber: [95, 511, 175, 16] as PdfBox,
  heaterLocation: [410, 511, 92, 16] as PdfBox,
  tankWarrantyYears: [168, 490, 102, 16] as PdfBox,
  dwellingType: [378, 490, 120, 16] as PdfBox,
  additional: [
    [41, 448, 460, 16],
    [41, 428, 460, 16],
    [41, 408, 460, 16],
    [41, 387, 460, 16],
    [41, 366, 460, 16],
  ] as PdfBox[],
  additionalPrice: [
    [512, 448, 66, 16],
    [512, 428, 66, 16],
    [512, 408, 66, 16],
    [512, 387, 66, 16],
    [512, 366, 66, 16],
  ] as PdfBox[],
  permitAmount: [512, 345, 66, 16] as PdfBox,
  totalAmount: [512, 320, 66, 18] as PdfBox,
  paymentMethod: [90, 274, 155, 16] as PdfBox,
  driversLicense: [318, 274, 250, 16] as PdfBox,
  cardOrCheckNumber: [148, 257, 175, 15] as PdfBox,
  routingNumber: [400, 257, 118, 15] as PdfBox,
  cardExp: [545, 257, 48, 15] as PdfBox,
  amountPaid: [132, 241, 88, 15] as PdfBox,
  customerSignature: [308, 236, 255, 26] as PdfBox,
  customerInitial: [532, 168, 48, 48] as PdfBox,
  extra: [
    [41, 136, 480, 16],
    [41, 115, 480, 16],
    [41, 96, 480, 14],
    [41, 76, 480, 16],
    [41, 58, 480, 14],
    [41, 38, 480, 16],
    [41, 17, 480, 16],
  ] as PdfBox[],
  extraPrice: [
    [540, 136, 40, 16],
    [540, 115, 40, 16],
    [540, 96, 40, 14],
    [540, 76, 40, 16],
    [540, 58, 40, 14],
    [540, 38, 40, 16],
    [540, 17, 40, 16],
  ] as PdfBox[],
};

/** One notes area covering every extra-work line so typing wraps onto the next printed line. */
export const HEATERS_WO_EXTRA_NOTES: PdfBox = (() => {
  const boxes = HEATERS_WO_FIELDS.extra;
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  const top = first[1] + first[3];
  return [first[0], last[1], first[2], top - last[1]];
})();

export function extraNotesValue(rows: { description?: string }[] | undefined): string {
  const descriptions = (rows || []).map((row) => row.description || '');
  while (descriptions.length && !descriptions[descriptions.length - 1]) descriptions.pop();
  return descriptions.join('\n');
}
