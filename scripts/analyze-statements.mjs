import fs from 'node:fs';
import path from 'node:path';

const src = path.join(process.env.USERPROFILE, 'Downloads', 'bank-statements (3).txt');
const text = fs.readFileSync(src, 'utf8');
const chunks = text.split(/^===== (.+?) =====\s*$/m);

function money(value) {
  return Number.parseFloat(String(value).replace(/[$,]/g, ''));
}

function grab(body, label) {
  const re = new RegExp(
    `${label}\\s+(\\d+)\\s+(-?[\\d,]+\\.\\d{2})`
  );
  const match = body.match(re);
  if (!match) return { count: 0, amount: 0 };
  return { count: Number(match[1]), amount: Math.abs(money(match[2])) };
}

function vendorSum(body, needles) {
  let total = 0;
  let count = 0;
  const lineRe =
    /(\d{2}\/\d{2})\s+(Card Purchase(?: With Pin| Return)?|Recurring Card Purchase|Non-Chase ATM Withdraw|ATM Withdrawal|ATM Cash Deposit|Fedwire Credit|Real Time Transfer|Zelle Payment To|Payroll Payment|Orig CO Name:[^\s]+)[\s\S]{0,280}?([\d,]+\.\d{2})(?!\d)/g;
  let match;
  while ((match = lineRe.exec(body))) {
    const blob = match[0].toLowerCase();
    if (!needles.some((n) => blob.includes(n))) continue;
    total += money(match[3]);
    count += 1;
  }
  return { total: Math.round(total * 100) / 100, count };
}

const vendorNeedles = {
  '1-800 Heaters wires': ['1 800 heaters', '1800 heaters'],
  'Square': ['bnf-square', 'square inc'],
  'Home Depot': ['home depot'],
  "Lowe's": ["lowe's", 'lowes '],
  'Bender Plumbing': ['bender plumb'],
  'Enterprise / fleet': ['enterprise rent'],
  'Payroll': ['payroll payment'],
  'MCA advances': ['slate advance', 'elitebusinesscap'],
  'Zelle': ['zelle payment'],
  'Meals / Dunkin': ['dunkin', "mcdonald", 'burger king', 'taco bell', 'starbucks', 'dominos', 'green tea'],
  'Amazon': ['amazon', 'amzn'],
  'Fuel': ['shell oil', 'sunoco', 'circle k'],
  'ADP': ['adp tax', 'adp fees', 'adp pay'],
};

const statements = [];
for (let i = 1; i < chunks.length; i += 2) {
  const name = chunks[i];
  const body = chunks[i + 1] || '';
  if (/\(\d+\)\.pdf$/.test(name)) continue;
  const fileDate = name.match(/^(\d{4})(\d{2})/);
  const deposits = grab(body, 'Deposits and Additions');
  const cards = grab(body, 'ATM & Debit Card Withdrawals');
  const electronic = grab(body, 'Electronic Withdrawals');
  const other = grab(body, 'Other Withdrawals');
  const fees = grab(body, 'Fees');
  const begin = body.match(/Beginning Balance\s+\$([\d,]+\.\d{2})/);
  const end = body.match(/Ending Balance\s+\d+\s+\$([\d,]+\.\d{2})/);
  const vendors = {};
  for (const [label, needles] of Object.entries(vendorNeedles)) {
    vendors[label] = vendorSum(body, needles);
  }
  const spend = cards.amount + electronic.amount + other.amount + fees.amount;
  statements.push({
    file: name,
    label: `${fileDate[1]}-${fileDate[2]}`,
    year: fileDate[1],
    month: fileDate[2],
    deposits: deposits.amount,
    cardOut: cards.amount,
    electronicOut: electronic.amount,
    otherOut: other.amount,
    fees: fees.amount,
    spend: Math.round(spend * 100) / 100,
    net: Math.round((deposits.amount - spend) * 100) / 100,
    begin: begin ? money(begin[1]) : 0,
    end: end ? money(end[1]) : 0,
    vendors,
  });
}

statements.sort((a, b) => a.label.localeCompare(b.label));

const totals = statements.reduce(
  (acc, row) => {
    for (const key of ['deposits', 'cardOut', 'electronicOut', 'otherOut', 'fees', 'spend', 'net']) {
      acc[key] += row[key];
    }
    return acc;
  },
  { deposits: 0, cardOut: 0, electronicOut: 0, otherOut: 0, fees: 0, spend: 0, net: 0 }
);
for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;

const vendorTotals = {};
for (const row of statements) {
  for (const [name, value] of Object.entries(row.vendors)) {
    vendorTotals[name] ??= { total: 0, count: 0 };
    vendorTotals[name].total += value.total;
    vendorTotals[name].count += value.count;
  }
}
for (const value of Object.values(vendorTotals)) {
  value.total = Math.round(value.total * 100) / 100;
}

const dest = path.join(process.cwd(), 'scripts', 'statement-analysis.json');
fs.writeFileSync(
  dest,
  JSON.stringify(
    {
      company: 'N & J Plumbing LLC',
      account: 'Chase Performance Business Checking ending 3509',
      coverage: `${statements[0].label} to ${statements[statements.length - 1].label}`,
      months: statements,
      totals,
      vendorTotals,
    },
    null,
    2
  )
);
console.log(JSON.stringify({ coverage: `${statements[0].label} to ${statements.at(-1).label}`, n: statements.length, totals, months: statements.map((m) => [m.label, m.deposits, m.spend, m.net]) }, null, 2));
