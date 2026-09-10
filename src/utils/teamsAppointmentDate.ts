export interface ScheduleDateEvidence {
  quote: string;
  start: number;
  end: number;
}

function findInsensitive(text: string, quote: string): number {
  return text.toLowerCase().indexOf(quote.toLowerCase());
}

/** Locate the AI-chosen booking phrase inside notes. Matching only; no date guessing. */
export function locateScheduleEvidenceQuote(
  notes: string,
  evidenceQuote?: string
): ScheduleDateEvidence | null {
  const text = notes || '';
  const quote = (evidenceQuote || '').trim();
  if (!text || !quote) return null;

  const exact = text.indexOf(quote);
  if (exact >= 0) {
    return { quote: text.slice(exact, exact + quote.length), start: exact, end: exact + quote.length };
  }

  const insensitive = findInsensitive(text, quote);
  if (insensitive >= 0) {
    return {
      quote: text.slice(insensitive, insensitive + quote.length),
      start: insensitive,
      end: insensitive + quote.length,
    };
  }

  const collapsedQuote = quote.replace(/\s+/g, ' ').trim();
  if (!collapsedQuote) return null;
  const map: number[] = [];
  let collapsed = '';
  let lastSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const space = /\s/.test(text[index]);
    if (space) {
      if (!lastSpace && collapsed.length > 0) {
        collapsed += ' ';
        map.push(index);
      }
      lastSpace = true;
      continue;
    }
    collapsed += text[index];
    map.push(index);
    lastSpace = false;
  }
  const collapsedAt = findInsensitive(collapsed, collapsedQuote);
  if (collapsedAt < 0) return null;
  const start = map[collapsedAt];
  const endIndex = collapsedAt + collapsedQuote.length - 1;
  const end = (map[endIndex] ?? start) + 1;
  return { quote: text.slice(start, end), start, end };
}
