import fs from "node:fs";
import path from "node:path";

const text = fs.readFileSync(
  path.join(process.env.USERPROFILE, "Downloads", "bank-statements (3).txt"),
  "utf8"
);
const analysis = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts", "statement-analysis.json"), "utf8")
);

function money(value) {
  return Number.parseFloat(String(value).replace(/,/g, ""));
}

function sum(re, min = 0, max = 1e9) {
  const next = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let total = 0;
  let count = 0;
  const samples = [];
  let match;
  while ((match = next.exec(text))) {
    const amount = money(match[1]);
    if (!Number.isFinite(amount) || amount < min || amount > max) continue;
    total += amount;
    count += 1;
    if (samples.length < 10) samples.push(amount);
  }
  return { total: Math.round(total * 100) / 100, count, samples };
}

const heaters = sum(
  /([\d,]+\.\d{2})\s+\d{2}\/\d{2}\s+Fedwire Credit Via:[\s\S]{0,140}1 800 Heaters/gi,
  100,
  250000
);
const square = sum(
  /([\d,]+\.\d{2})\s+\d{2}\/\d{2}\s+[\s\S]{0,40}(?:Orig CO Name:Square|Bnf-Square)/gi,
  1,
  50000
);
const payroll = sum(/Payroll Payment[\s\S]{0,90}?([\d,]+\.\d{2})/gi, 20, 15000);
const mca = sum(
  /Orig CO Name:(?:Slate Advance|Elitebusinesscap)[\s\S]{0,240}?(\d+\.\d{2})/gi,
  50,
  500
);
const homeDepot = sum(
  /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,80}?the home depot[\s\S]{0,40}?([\d,]+\.\d{2})/gi,
  1,
  5000
);
const enterprise = sum(
  /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,80}?enterprise rent[\s\S]{0,40}?([\d,]+\.\d{2})/gi,
  1,
  8000
);

console.log(
  JSON.stringify(
    {
      cash: analysis.months.map((m) => ({
        label: m.label,
        begin: m.begin,
        end: m.end,
        deposits: m.deposits,
        spend: m.spend,
        net: m.net,
      })),
      refined: { heaters, square, payroll, mca, homeDepot, enterprise },
      official: analysis.totals,
      vendorTotals: analysis.vendorTotals,
    },
    null,
    2
  )
);
