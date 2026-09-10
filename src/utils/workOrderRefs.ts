export function compactWorkOrderNumber(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^wo[\s#:_-]*/i, '')
    .replace(/[\s\-_]/g, '');
}

export function extractWorkOrderNumbers(...texts: string[]): string[] {
  const hay = texts.filter(Boolean).join('\n');
  const found = new Set<string>();
  const patterns = [
    /\b(?:wo|w\.?o\.?|work[\s_-]*order)[\s#:._-]*(\d{5,8})\b/gi,
    /\b(?:sales[\s_-]*order)[\s#:._-]*(\d{5,8})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of hay.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

export function attachmentLooksLikeWorkOrder(
  fileName: string,
  workOrderNumber?: string
): boolean {
  const name = fileName.toLowerCase();
  if (!name.endsWith('.pdf') && !name.includes('pdf')) return false;
  if (!workOrderNumber) return /(?:wo|work\s*order|sales\s*order)/i.test(fileName);
  const compact = compactWorkOrderNumber(workOrderNumber);
  return compactWorkOrderNumber(fileName).includes(compact) || name.includes(compact);
}
