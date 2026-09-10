const MAX_INSTALL_CHARS = 400;

export function stripInstallPrices(text: string): string {
  return String(text || "")
    .replace(/\$\s*[\d,]+(?:\.\d{2})?/g, " ")
    .replace(/(?:^|\s)[\d,]+\.\d{2}(?=\s|$)/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const RETAILER =
  /(?:The\s+Home\s+Depot|Home\s+Depot|Lowe['’]?s|Lowes|Menards)/i;

function compactInstallText(source: string): string {
  return stripInstallPrices(String(source || "").replace(/\r/g, "\n"))
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, " ")
    .trim();
}

function tidyHeaterType(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\bThe\s+Home\s+Depot\b/i, "Home Depot")
    .replace(/\bLowes\b/i, "Lowe's")
    .replace(/\bLowe['’]s\b/i, "Lowe's")
    .trim();
}

/** Short plumber label such as "Lowe's Model EEA12-40R55DVF". */
export function heaterTypeLabel(source: string): string {
  const compact = compactInstallText(source);
  if (!compact) return "";

  const retailerModel = compact.match(
    new RegExp(`${RETAILER.source}\\s+Model\\s+[A-Z0-9][A-Z0-9-]*`, "i")
  );
  if (retailerModel?.[0]) return tidyHeaterType(retailerModel[0]);

  const model = compact.match(/\bModel\s+[A-Z0-9][A-Z0-9-]{4,}/i);
  if (model?.[0]) {
    const retailer = compact.match(RETAILER);
    return tidyHeaterType(retailer ? `${retailer[0]} ${model[0]}` : model[0]);
  }

  const gallonType = compact.match(
    /\b\d{2,3}\s*(?:gallon|gal)\.?\s+(?:natural\s+gas|gas|electric|propane|lp|hybrid)?\s*(?:tankless\s+)?(?:rheem|bradford(?:\s*white)?|a\.?o\.?\s*smith|gladiator)?\s*(?:tankless\s+)?water\s+heaters?\b/i
  );
  if (gallonType?.[0]) return tidyHeaterType(gallonType[0]);

  return "";
}

export function heaterModelFromDescription(description: string): string {
  return description.match(/Model\s+([A-Z0-9][A-Z0-9-]*)/i)?.[1] || "";
}

function normalizeInstallChunk(chunk: string): string {
  let value = stripInstallPrices(chunk.replace(/\n+/g, " "));
  const markers = [
    value.match(/Model\s+[A-Z0-9][A-Z0-9-]*/i),
    value.match(/SKU\s+\d+/i),
  ].filter((match): match is RegExpMatchArray => Boolean(match));
  if (markers.length) {
    const last = markers.reduce((winner, match) => {
      const winnerEnd = (winner.index || 0) + winner[0].length;
      const matchEnd = (match.index || 0) + match[0].length;
      return matchEnd > winnerEnd ? match : winner;
    });
    value = value.slice(0, (last.index || 0) + last[0].length);
  }
  return value.replace(/^[^A-Za-z]+/, "").slice(0, MAX_INSTALL_CHARS).trim();
}

export function extractInstallDescription(source: string): string {
  const text = String(source || "").replace(/\r/g, "\n");
  if (!text.trim()) return "";
  const collapsed = text.replace(/[ \t]+/g, " ");

  const furnished = collapsed.match(
    /Furnished Install[\s\S]{8,500}?(?:Model\s+[A-Z0-9][A-Z0-9-]*|SKU\s+\d{6,})/i
  );
  if (furnished?.[0]) return normalizeInstallChunk(furnished[0]);

  const heaterLine = collapsed.match(
    /(?:^|\n)([^\n]{0,120}(?:water heater|tank type)[^\n]{0,240}(?:SKU\s+\d+|Model\s+[A-Z0-9-]+))/i
  );
  if (heaterLine?.[1]) return normalizeInstallChunk(heaterLine[1]);

  const compact = stripInstallPrices(collapsed.replace(/\n+/g, " "));
  if (
    /(?:SKU\s+\d+|Model\s+[A-Z0-9-]{5,})/i.test(compact) &&
    /heater|gallon|rheem|bradford|a\.?o\.?\s*smith|gladiator|tank type/i.test(compact)
  ) {
    return normalizeInstallChunk(compact);
  }
  return "";
}

const MONTH_TO_NUM: Record<string, string> = {
  january: "01",
  jan: "01",
  february: "02",
  feb: "02",
  march: "03",
  mar: "03",
  april: "04",
  apr: "04",
  may: "05",
  june: "06",
  jun: "06",
  july: "07",
  jul: "07",
  august: "08",
  aug: "08",
  september: "09",
  sept: "09",
  sep: "09",
  october: "10",
  oct: "10",
  november: "11",
  nov: "11",
  december: "12",
  dec: "12",
};

function parseLooseUsDate(raw: string): string {
  const slash = raw.trim().match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const named = raw
    .trim()
    .match(
      /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i
    );
  if (!named) return "";
  const month = MONTH_TO_NUM[named[1].toLowerCase().replace(/\.$/, "")];
  const day = Number(named[2]);
  const year = Number(named[3]);
  if (!month || day < 1 || day > 31) return "";
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

/** Requested/install date printed on a work-order PDF — not the sales-order date. */
export function extractPdfServiceDate(source: string): string {
  const text = String(source || "").replace(/\s+/g, " ");
  const labeled = text.match(
    /(?:Requested Date|Install(?:ation)? Date|Service Date|Scheduled Date|Appointment Date)\s*[:#.]?\s*([A-Za-z0-9,./\- ]{4,40})/i
  );
  if (!labeled?.[1]) return "";
  return parseLooseUsDate(labeled[1]);
}
