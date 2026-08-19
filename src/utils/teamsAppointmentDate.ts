export interface ScheduleDateEvidence {
  quote: string;
  start: number;
  end: number;
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

  const lowerNotes = text.toLowerCase();
  const lowerQuote = quote.toLowerCase();
  const insensitive = lowerNotes.indexOf(lowerQuote);
  if (insensitive >= 0) {
    return {
      quote: text.slice(insensitive, insensitive + quote.length),
      start: insensitive,
      end: insensitive + quote.length,
    };
  }

  return null;
}
