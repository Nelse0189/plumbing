/** 1-800 Heaters customer sales-order email pasted into Teams. */

export function looksLikeSalesOrderBoilerplate(text: string): boolean {
  const body = text.replace(/^\[[^\]]+\]\s*/, '').trim();
  if (!body) return false;
  if (/Your sales order is attached/i.test(body)) return true;
  if (/Please reply with the word [“"'‘]READ[”"'’]/i.test(body) && body.length > 400) {
    return true;
  }
  if (
    /text pictures of both your entire water heater/i.test(body) &&
    /price quoted DOES NOT include/i.test(body)
  ) {
    return true;
  }
  if (
    /Thank you very much for choosing us to perform/i.test(body) &&
    /833[\s().-]*909[\s().-]*3100/.test(body)
  ) {
    return true;
  }
  return false;
}

export function stripSalesOrderBoilerplate(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (looksLikeSalesOrderBoilerplate(text)) return '';
  const start = text.search(/Dear\s+.+:\s*Your sales order is attached/i);
  if (start < 0) return text;
  const header = text.slice(0, start).trim();
  if (!header || /^\[[^\]]+\]$/.test(header) || / · post\]$/i.test(header)) {
    return '';
  }
  return header;
}

/** Drop sales-order email blocks; keep plumber notes and short posts. */
export function omitSalesOrderBoilerplate(text: string): string {
  const source = String(text || '').trim();
  if (!source) return '';
  if (looksLikeSalesOrderBoilerplate(source)) return '';
  const parts = source.split(/(?=\[\d{4}-\d{2}-\d{2}T[^\]]* · (?:post|reply)\])/);
  const blocks = (parts.length > 1 ? parts : source.split(/\n\n+/))
    .map((block) => stripSalesOrderBoilerplate(block))
    .filter(Boolean);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
