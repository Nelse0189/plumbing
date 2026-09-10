function phoneToken(): RegExp {
  return /(?:\+?1[-.\s]*)?(?:\(\d{3}\)|\d{3})[-.\s]*\d{3}[-.\s]*\d{4}/g;
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '').slice(-10);
}

function isTollFree(e164: string): boolean {
  return /^\+1(800|888|877|866|855|844|833)/.test(e164);
}

/** Normalize a US number to +1XXXXXXXXXX, or empty if it is not usable. */
export function coerceCustomerPhone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  let e164 = '';
  if (trimmed.startsWith('+') && /^\+\d{10,15}$/.test(`+${trimmed.slice(1).replace(/\D/g, '')}`)) {
    e164 = `+${trimmed.slice(1).replace(/\D/g, '')}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    e164 = `+${digits}`;
  } else if (digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (digits.length > 11 && digits.startsWith('1')) {
    e164 = `+${digits.slice(0, 11)}`;
  } else if (digits.length > 10) {
    e164 = `+1${digits.slice(0, 10)}`;
  }
  if (!/^\+\d{10,15}$/.test(e164) || isTollFree(e164)) return '';
  return e164;
}

/**
 * Pull every distinct US customer number out of free text or stored fields.
 * Handles "Phone # 2035785718 2036318561" and "203-578-5718 / 203-631-8561".
 */
export function parseCustomerPhones(
  ...values: Array<string | string[] | undefined | null>
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const phone = coerceCustomerPhone(raw);
    if (!phone) return;
    const key = digitsOf(phone);
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push(phone);
  };

  for (const value of values) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) add(String(item || ''));
      continue;
    }
    const text = String(value);
    let matched = false;
    for (const match of text.matchAll(phoneToken())) {
      matched = true;
      add(match[0]);
    }
    if (!matched) add(text);
  }
  return found;
}

export function customerPhonesOf(record: {
  phone?: string;
  phones?: string[];
}): string[] {
  return parseCustomerPhones(record.phones, record.phone);
}

export function formatCustomerPhone(phone: string): string {
  const digits = digitsOf(phone);
  if (digits.length !== 10) return phone.trim() || phone;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function formatCustomerPhones(record: {
  phone?: string;
  phones?: string[];
}): string {
  const phones = customerPhonesOf(record);
  if (phones.length === 0) return '';
  return phones.map(formatCustomerPhone).join(' / ');
}

export function customerPhonesMatch(left: string, right: string): boolean {
  const a = digitsOf(left);
  const b = digitsOf(right);
  return Boolean(a) && a === b;
}
