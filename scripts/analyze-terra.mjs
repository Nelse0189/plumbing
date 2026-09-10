import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const require = createRequire(path.join(root, "functions", "package.json"));
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config({ path: path.join(root, "functions", ".env") });
dotenv.config({ path: path.join(root, "functions", ".env.nj-plumbing") });

const text = fs.readFileSync(
  path.join(process.env.USERPROFILE, "Downloads", "bank-statements (3).txt"),
  "utf8"
);
const analysis = JSON.parse(
  fs.readFileSync(path.join(root, "scripts", "statement-analysis.json"), "utf8")
);

function money(value) {
  return Number.parseFloat(String(value).replace(/[$,]/g, ""));
}

function sumAfter(re, min, max) {
  const next = new RegExp(re.source, "gi");
  let total = 0;
  let count = 0;
  const samples = [];
  let match;
  while ((match = next.exec(text))) {
    const amount = money(match[1]);
    if (!Number.isFinite(amount) || amount < min || amount > max) continue;
    total += amount;
    count += 1;
    if (samples.length < 8) samples.push(amount);
  }
  return { total: Math.round(total * 100) / 100, count, samples };
}

const vendors = {
  heatersWires: sumAfter(
    /1 800 Heaters[\s\S]{0,520}?Trn:\s*\S+\s+\$?([\d,]+\.\d{2})/,
    200,
    200000
  ),
  squareTransfers: sumAfter(
    /Bnf-Square[\s\S]{0,420}?Trn:\s*\S+\s+\$?([\d,]+\.\d{2})/,
    20,
    80000
  ),
  payroll: sumAfter(/Payroll Payment[\s\S]{0,90}?([\d,]+\.\d{2})/, 20, 12000),
  mcaDailyPulls: sumAfter(
    /Orig CO Name:(?:Slate Advance|Elitebusinesscap)[\s\S]{0,280}?(\$?\d+\.\d{2})/,
    50,
    250
  ),
  homeDepot: sumAfter(
    /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,90}the home depot[\s\S]{0,50}?([\d,]+\.\d{2})/,
    1,
    4000
  ),
  lowes: sumAfter(
    /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,90}lowe'?s[\s\S]{0,50}?([\d,]+\.\d{2})/,
    1,
    4000
  ),
  bender: sumAfter(
    /(?:Card Purchase(?: With Pin)?|Card Purchase Return) \d{2}\/\d{2} [\s\S]{0,90}bender plumb[\s\S]{0,50}?([\d,]+\.\d{2})/,
    1,
    8000
  ),
  enterprise: sumAfter(
    /Card Purchase(?: With Pin)? \d{2}\/\d{2} [\s\S]{0,90}enterprise rent[\s\S]{0,50}?([\d,]+\.\d{2})/,
    20,
    8000
  ),
  meals: analysis.vendorTotals["Meals / Dunkin"],
  amazon: analysis.vendorTotals.Amazon,
  zelle: analysis.vendorTotals.Zelle,
  adp: analysis.vendorTotals.ADP,
  fuel: analysis.vendorTotals.Fuel,
};

const months = analysis.months.map((m) => ({
  month: m.label,
  deposits: m.deposits,
  cardSpend: m.cardOut,
  electronicSpend: m.electronicOut,
  otherSpend: m.otherOut,
  fees: m.fees,
  totalOut: m.spend,
  net: m.net,
  beginBalance: m.begin,
  endBalance: m.end,
}));

const y2025 = months.filter((m) => m.month.startsWith("2025"));
const y2026 = months.filter((m) => m.month.startsWith("2026"));
function roll(rows) {
  return {
    months: rows.length,
    deposits: Math.round(rows.reduce((s, r) => s + r.deposits, 0) * 100) / 100,
    spend: Math.round(rows.reduce((s, r) => s + r.totalOut, 0) * 100) / 100,
    net: Math.round(rows.reduce((s, r) => s + r.net, 0) * 100) / 100,
    avgDeposits:
      Math.round((rows.reduce((s, r) => s + r.deposits, 0) / rows.length) * 100) / 100,
    avgSpend:
      Math.round((rows.reduce((s, r) => s + r.totalOut, 0) / rows.length) * 100) / 100,
  };
}

const compact = {
  company: analysis.company,
  account: analysis.account,
  coverage: analysis.coverage,
  missingStatementMonths: ["2026-02", "2026-03"],
  officialTotals: analysis.totals,
  year2025: roll(y2025),
  year2026Partial: roll(y2026),
  months,
  merchantEstimates: vendors,
  notes: [
    "Official Chase checking-summary totals are ground truth.",
    "Merchant estimates are parsed from PDF text and can over/under count continued pages.",
    "MCA = daily ACH to Slate Advance and Elitebusinesscap, typically $100 each.",
    "Feb and Mar 2026 PDFs were not in the extract.",
    "Personal-looking card spend (Florida travel, meals) appears on the business debit card.",
  ],
};

fs.writeFileSync(
  path.join(root, "scripts", "statement-compact.json"),
  JSON.stringify(compact, null, 2)
);

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("OPENAI_API_KEY missing in functions/.env");
}

const client = new OpenAI({ apiKey });
const prompt = `You are a senior advisor preparing a client-facing financial briefing for N & J Plumbing LLC (Farmington, CT), a field plumbing contractor.

Use ONLY the JSON facts. Do not invent numbers. If a merchant total is an estimate, say so.

Return STRICT JSON with this shape:
{
  "headline": "one sentence on the business cash story",
  "kpis": [{"label":"","value":"","note":""}],
  "narrative": ["3-5 short paragraphs for a client"],
  "findings": [{"title":"","severity":"high|medium|low","body":""}],
  "recommendations": [{"title":"","body":""}],
  "talkingPoints": ["short bullets a presenter can say out loud"]
}

Be professional. Do not name private Zelle recipients. Frame mixed personal spend as a bookkeeping / owner-draw issue, not a scandal. MCA daily pulls are expensive working-capital. Enterprise Rent-A-Car clustering is a fleet cost. 1-800 Heaters wires and Square are revenue channels. Cash stays thin vs monthly volume.`;

const completion = await client.chat.completions.create({
  model: "gpt-5.6-terra",
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: prompt },
    { role: "user", content: JSON.stringify(compact) },
  ],
});

const raw = completion.choices[0]?.message?.content || "{}";
const findings = JSON.parse(raw);
const out = {
  model: completion.model,
  usage: completion.usage,
  compact,
  findings,
};
fs.writeFileSync(
  path.join(root, "scripts", "terra-findings.json"),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      model: completion.model,
      usage: completion.usage,
      heaters: vendors.heatersWires,
      square: vendors.squareTransfers,
      payroll: vendors.payroll,
      mca: vendors.mcaDailyPulls,
      headline: findings.headline,
      findingCount: findings.findings?.length,
    },
    null,
    2
  )
);
