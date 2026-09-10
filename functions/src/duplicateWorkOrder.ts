export function parseDuplicateWorkOrderNumber(notes: string): string {
  const text = String(notes || "");
  if (!text.trim()) return "";
  const patterns = [
    /already on schedule with (?:another|a different) work order(?: number)?\s*[:#]?\s*(\d{5,8})/i,
    /duplicate of(?: work order(?: number)?)?\s*[:#]?\s*(\d{5,8})/i,
    /repeat order[\s\S]{0,160}?work order(?: number)?\s*[:#]?\s*(\d{5,8})/i,
    /different work order(?: number)?\s*[:#]?\s*(\d{5,8})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

/**
 * The notes say this PDF is a re-send of a job filed under a DIFFERENT work
 * order number. A "repeat order" note that names no other number, or names
 * this job's own number, is the same job posted again and must still schedule
 * under this number; only the server can tell those apart by customer, and it
 * records its decision in duplicateOfWorkOrderNumber.
 */
export function notesDuplicateAnotherWorkOrder(
  notes: string,
  ownWorkOrderNumber: string
): boolean {
  const original = parseDuplicateWorkOrderNumber(notes);
  if (!original) return false;
  return original !== String(ownWorkOrderNumber || "").trim();
}

export function notesLookLikeDuplicateOrder(notes: string): boolean {
  const text = String(notes || "");
  if (parseDuplicateWorkOrderNumber(text)) return true;
  if (/\brepeat order(?:\s+repeat order){1,}/i.test(text)) return true;
  if (/\bthis (?:is|was) (?:a )?duplicate (?:order|work order)\b/i.test(text)) {
    return true;
  }
  return false;
}
