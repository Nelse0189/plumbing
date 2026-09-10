import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app, 'us-central1');

export type StatementSection = {
  name: string;
  text: string;
};

export type VendorTotal = {
  total: number;
  count: number;
};

export type StatementMonth = {
  label: string;
  file: string;
  deposits: number;
  cardOut: number;
  electronicOut: number;
  otherOut: number;
  fees: number;
  spend: number;
  net: number;
  begin: number;
  end: number;
  vendors: Record<string, VendorTotal>;
};

export type StatementFileInfo = {
  name: string;
  month: string | null;
  duplicate: boolean;
};

export type StatementCashAnalysis = {
  company: string;
  account: string;
  fileCount: number;
  uniqueMonthCount: number;
  files: StatementFileInfo[];
  duplicateNames: string[];
  missingMonths: string[];
  coverage: string;
  months: StatementMonth[];
  totals: {
    deposits: number;
    cardOut: number;
    electronicOut: number;
    otherOut: number;
    fees: number;
    spend: number;
    net: number;
  };
  year2025: YearRollup;
  year2026: YearRollup;
  vendorTotals: Record<string, VendorTotal>;
};

export type YearRollup = {
  months: number;
  deposits: number;
  spend: number;
  net: number;
  avgDeposits: number;
  avgSpend: number;
};

export type TerraFinding = {
  title: string;
  severity: 'high' | 'medium' | 'low';
  body: string;
};

export type TerraPassResult = {
  pass: 'cash' | 'costs' | 'briefing';
  headline: string;
  narrative: string[];
  findings: TerraFinding[];
  recommendations: { title: string; body: string }[];
  talkingPoints: string[];
  model: string;
};

export type TerraBriefing = {
  cash: TerraPassResult | null;
  costs: TerraPassResult | null;
  briefing: TerraPassResult | null;
};

const VENDOR_PATTERNS: { label: string; re: RegExp; min: number; max: number }[] = [
  {
    label: '1-800 Heaters wires',
    re: /1 800 Heaters[\s\S]{0,520}?Trn:\s*\S+\s+\$?([\d,]+\.\d{2})/gi,
    min: 200,
    max: 200000,
  },
  {
    label: 'Square',
    re: /Bnf-Square[\s\S]{0,420}?Trn:\s*\S+\s+\$?([\d,]+\.\d{2})/gi,
    min: 20,
    max: 80000,
  },
  {
    label: 'Payroll',
    re: /Payroll Payment[\s\S]{0,90}?([\d,]+\.\d{2})/gi,
    min: 20,
    max: 12000,
  },
  {
    label: 'MCA advances',
    re: /Orig CO Name:(?:Slate Advance|Elitebusinesscap)[\s\S]{0,280}?(\$?\d+\.\d{2})/gi,
    min: 50,
    max: 250,
  },
  {
    label: 'Home Depot',
    re: /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,90}the home depot[\s\S]{0,50}?([\d,]+\.\d{2})/gi,
    min: 1,
    max: 4000,
  },
  {
    label: "Lowe's",
    re: /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,90}lowe'?s[\s\S]{0,50}?([\d,]+\.\d{2})/gi,
    min: 1,
    max: 4000,
  },
  {
    label: 'Bender Plumbing',
    re: /(?:Card Purchase(?: With Pin)?|Card Purchase Return) \d{2}\/\d{2} [\s\S]{0,90}bender plumb[\s\S]{0,50}?([\d,]+\.\d{2})/gi,
    min: 1,
    max: 8000,
  },
  {
    label: 'Enterprise / fleet',
    re: /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,90}enterprise rent[\s\S]{0,50}?([\d,]+\.\d{2})/gi,
    min: 20,
    max: 8000,
  },
  {
    label: 'Zelle',
    re: /Zelle Payment[\s\S]{0,80}?([\d,]+\.\d{2})/gi,
    min: 1,
    max: 20000,
  },
  {
    label: 'Meals / QSR',
    re: /Card Purchase(?: With Pin| Return)? \d{2}\/\d{2} [\s\S]{0,80}(?:dunkin|mcdonald|burger king|taco bell|starbucks|dominos|green tea)[\s\S]{0,40}?([\d,]+\.\d{2})/gi,
    min: 1,
    max: 200,
  },
  {
    label: 'Amazon',
    re: /Card Purchase(?: With Pin| Return)? \d{2}\/\d{2} [\s\S]{0,80}(?:amazon|amzn)[\s\S]{0,40}?([\d,]+\.\d{2})/gi,
    min: 1,
    max: 2000,
  },
  {
    label: 'ADP',
    re: /Orig CO Name:ADP[\s\S]{0,280}?(\$?[\d,]+\.\d{2})/gi,
    min: 1,
    max: 20000,
  },
];

function money(value: string) {
  return Number.parseFloat(value.replace(/[$,]/g, ''));
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function grab(body: string, label: string) {
  const match = body.match(new RegExp(`${label}\\s+(\\d+)\\s+(-?[\\d,]+\\.\\d{2})`));
  if (!match) return { count: 0, amount: 0 };
  return { count: Number(match[1]), amount: Math.abs(money(match[2])) };
}

function vendorSum(body: string, re: RegExp, min: number, max: number): VendorTotal {
  const next = new RegExp(re.source, 'gi');
  let total = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = next.exec(body))) {
    const amount = money(match[1]);
    if (!Number.isFinite(amount) || amount < min || amount > max) continue;
    total += amount;
    count += 1;
  }
  return { total: round2(total), count };
}

function monthFromName(name: string) {
  const match = name.match(/^(\d{4})(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function isCopyName(name: string) {
  return /\(\d+\)\.pdf$/i.test(name);
}

function addMonths(label: string, delta: number) {
  const [year, month] = label.split('-').map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthSpan(start: string, end: string) {
  const labels: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addMonths(cursor, 1)) {
    labels.push(cursor);
  }
  return labels;
}

function roll(months: StatementMonth[]): YearRollup {
  if (!months.length) {
    return { months: 0, deposits: 0, spend: 0, net: 0, avgDeposits: 0, avgSpend: 0 };
  }
  const deposits = round2(months.reduce((sum, row) => sum + row.deposits, 0));
  const spend = round2(months.reduce((sum, row) => sum + row.spend, 0));
  const net = round2(months.reduce((sum, row) => sum + row.net, 0));
  return {
    months: months.length,
    deposits,
    spend,
    net,
    avgDeposits: round2(deposits / months.length),
    avgSpend: round2(spend / months.length),
  };
}

export function analyzeStatementSections(sections: StatementSection[]): StatementCashAnalysis | null {
  if (!sections.length) return null;

  const files: StatementFileInfo[] = sections.map((section) => ({
    name: section.name,
    month: monthFromName(section.name),
    duplicate: isCopyName(section.name),
  }));

  const byMonth = new Map<string, StatementSection>();
  const duplicateNames: string[] = [];
  for (const section of [...sections].sort((left, right) => {
    const copyBias = Number(isCopyName(left.name)) - Number(isCopyName(right.name));
    return copyBias || left.name.localeCompare(right.name, undefined, { numeric: true });
  })) {
    const month = monthFromName(section.name);
    if (!month) continue;
    if (byMonth.has(month)) {
      duplicateNames.push(section.name);
      continue;
    }
    byMonth.set(month, section);
  }

  const months: StatementMonth[] = [...byMonth.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, section]) => {
      const deposits = grab(section.text, 'Deposits and Additions');
      const cards = grab(section.text, 'ATM & Debit Card Withdrawals');
      const electronic = grab(section.text, 'Electronic Withdrawals');
      const other = grab(section.text, 'Other Withdrawals');
      const fees = grab(section.text, 'Fees');
      const begin = section.text.match(/Beginning Balance\s+\$([\d,]+\.\d{2})/);
      const end = section.text.match(/Ending Balance\s+\d+\s+\$([\d,]+\.\d{2})/);
      const vendors: Record<string, VendorTotal> = {};
      for (const pattern of VENDOR_PATTERNS) {
        vendors[pattern.label] = vendorSum(section.text, pattern.re, pattern.min, pattern.max);
      }
      const spend = round2(cards.amount + electronic.amount + other.amount + fees.amount);
      return {
        label,
        file: section.name,
        deposits: deposits.amount,
        cardOut: cards.amount,
        electronicOut: electronic.amount,
        otherOut: other.amount,
        fees: fees.amount,
        spend,
        net: round2(deposits.amount - spend),
        begin: begin ? money(begin[1]) : 0,
        end: end ? money(end[1]) : 0,
        vendors,
      };
    });

  const uniqueMonths = months.map((row) => row.label);
  const missingMonths =
    uniqueMonths.length >= 2 ? monthSpan(uniqueMonths[0], uniqueMonths.at(-1)!).filter((label) => !byMonth.has(label)) : [];

  const totals = months.reduce(
    (acc, row) => {
      acc.deposits += row.deposits;
      acc.cardOut += row.cardOut;
      acc.electronicOut += row.electronicOut;
      acc.otherOut += row.otherOut;
      acc.fees += row.fees;
      acc.spend += row.spend;
      acc.net += row.net;
      return acc;
    },
    { deposits: 0, cardOut: 0, electronicOut: 0, otherOut: 0, fees: 0, spend: 0, net: 0 }
  );
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
    totals[key] = round2(totals[key]);
  }

  const vendorTotals: Record<string, VendorTotal> = {};
  for (const row of months) {
    for (const [label, value] of Object.entries(row.vendors)) {
      vendorTotals[label] ??= { total: 0, count: 0 };
      vendorTotals[label].total += value.total;
      vendorTotals[label].count += value.count;
    }
  }
  for (const value of Object.values(vendorTotals)) {
    value.total = round2(value.total);
  }

  return {
    company: 'N & J Plumbing LLC',
    account: 'Chase Performance Business Checking ending 3509',
    fileCount: sections.length,
    uniqueMonthCount: months.length,
    files,
    duplicateNames,
    missingMonths,
    coverage: uniqueMonths.length ? `${uniqueMonths[0]} to ${uniqueMonths.at(-1)}` : '',
    months,
    totals,
    year2025: roll(months.filter((row) => row.label.startsWith('2025'))),
    year2026: roll(months.filter((row) => row.label.startsWith('2026'))),
    vendorTotals,
  };
}

export type SavingsLever = {
  rank: number;
  title: string;
  observed: number;
  monthly: number;
  yearRunRate: number;
  targetYear: number;
  how: string;
  when: string;
  caveat: string;
};

export function buildSavingsLevers(analysis: StatementCashAnalysis): SavingsLever[] {
  const months = Math.max(analysis.uniqueMonthCount, 1);
  const amount = (label: string) => analysis.vendorTotals[label]?.total || 0;
  const runRate = (value: number) => Math.round(((value * 12) / months) * 100) / 100;
  const mca = amount('MCA advances');
  const fleet = amount('Enterprise / fleet');
  const homeDepot = amount('Home Depot');
  const meals = amount('Meals / QSR');
  return [
    {
      rank: 1,
      title: 'Stop MCA daily ACH',
      observed: mca,
      monthly: runRate(mca) / 12,
      yearRunRate: runRate(mca),
      targetYear: runRate(mca),
      how: 'Get remaining balances and buyout quotes from Slate Advance and Elitebusinesscap this week. Do not take another advance. Once paid off, the ~$100 daily pulls stop hitting checking before payroll and materials.',
      when: 'This week',
      caveat:
        'Most of the observed total is repayment of money already received, plus a high factor fee. The cash-flow win is stopping the sweep. The true profit save is the factor — get that number from the lenders before comparing to a line of credit.',
    },
    {
      rank: 2,
      title: 'Replace long-term Enterprise rentals',
      observed: fleet,
      monthly: runRate(fleet) / 12,
      yearRunRate: runRate(fleet),
      targetYear: Math.round(runRate(fleet) * 0.25 * 100) / 100,
      how: 'Map repeating $379–$424 charges to trucks. Keep overflow rental for peaks. Finance or buy the units that have been on-rent for months. Job-recover fleet cost on every Heaters ticket.',
      when: 'Next 30 days',
      caveat: '25% cut assumes two long-term rentals convert and peak-season rentals remain. Do not sell this as a 100% cut.',
    },
    {
      rank: 3,
      title: 'Shift Home Depot to wholesale',
      observed: homeDepot,
      monthly: runRate(homeDepot) / 12,
      yearRunRate: runRate(homeDepot),
      targetYear: Math.round(runRate(homeDepot) * 0.1 * 100) / 100,
      how: 'Stage Bender / supplier orders by job instead of 50+ Home Depot runs a month. Emergency HD is fine. Daily HD is a tax.',
      when: 'Next 60 days',
      caveat: '10% of Home Depot spend is a conservative parts-spread target, not a guarantee.',
    },
    {
      rank: 4,
      title: 'Cap mixed meals and card spend',
      observed: meals,
      monthly: runRate(meals) / 12,
      yearRunRate: runRate(meals),
      targetYear: Math.round(runRate(meals) * 0.4 * 100) / 100,
      how: 'Per-diem or weekly meal cap for crews. Owner travel and personal card activity coded as draws, not job cost.',
      when: 'This month',
      caveat: 'This is discipline money, not the business. Do it for clean books and a few thousand a year.',
    },
  ];
}

export function compactForTerra(analysis: StatementCashAnalysis) {
  return {
    company: analysis.company,
    account: analysis.account,
    coverage: analysis.coverage,
    fileCount: analysis.fileCount,
    uniqueMonthCount: analysis.uniqueMonthCount,
    duplicateFiles: analysis.duplicateNames,
    missingStatementMonths: analysis.missingMonths,
    officialTotals: analysis.totals,
    year2025: analysis.year2025,
    year2026Partial: analysis.year2026,
    months: analysis.months.map((row) => ({
      month: row.label,
      deposits: row.deposits,
      cardSpend: row.cardOut,
      electronicSpend: row.electronicOut,
      otherSpend: row.otherOut,
      fees: row.fees,
      totalOut: row.spend,
      net: row.net,
      beginBalance: row.begin,
      endBalance: row.end,
    })),
    merchantEstimates: analysis.vendorTotals,
    notes: [
      'Official Chase checking-summary totals are ground truth.',
      'Merchant estimates are parsed from PDF text and can over/under count continued pages.',
      'MCA = daily ACH to Slate Advance and Elitebusinesscap, typically $100 each.',
      'Duplicate Windows copies such as "(1).pdf" are excluded from monthly totals.',
      'Personal-looking card spend should be framed as bookkeeping / owner-draw, not a scandal.',
    ],
  };
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 12) : [];
}

function asFindings(value: unknown): TerraFinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const severity = row.severity === 'high' || row.severity === 'low' ? row.severity : 'medium';
    return {
      title: String(row.title || 'Finding'),
      severity,
      body: String(row.body || ''),
    };
  });
}

function asRecommendations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return { title: String(row.title || 'Next step'), body: String(row.body || '') };
  });
}

function normalizePass(pass: TerraPassResult['pass'], data: Record<string, unknown>, model: string): TerraPassResult {
  return {
    pass,
    headline: String(data.headline || ''),
    narrative: asStringArray(data.narrative),
    findings: asFindings(data.findings),
    recommendations: asRecommendations(data.recommendations),
    talkingPoints: asStringArray(data.talkingPoints),
    model,
  };
}

export async function runTerraStatementPass(input: {
  pass: TerraPassResult['pass'];
  compact: ReturnType<typeof compactForTerra>;
  prior?: Partial<TerraBriefing>;
}): Promise<TerraPassResult> {
  const call = httpsCallable<typeof input, { pass: TerraPassResult['pass']; model: string; result: Record<string, unknown> }>(
    functions,
    'analyzeBankStatements',
    { timeout: 180000 }
  );
  const response = await call(input);
  return normalizePass(response.data.pass, response.data.result || {}, response.data.model || 'gpt-5.6-terra');
}

export function formatCallableError(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: string }).message).replace(/^FirebaseError:\s*/i, '');
  }
  return error instanceof Error ? error.message : String(error);
}

export function monthShort(label: string) {
  const [year, month] = label.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(month) - 1] || month} ${year.slice(2)}`;
}
