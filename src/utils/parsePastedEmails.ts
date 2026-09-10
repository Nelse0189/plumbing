export interface PastedEmail {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

function headerValue(block: string, name: string): string {
  const match = block.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || "";
}

function parseOne(block: string): PastedEmail {
  const text = block.replace(/\r\n/g, "\n").trim();
  const split = text.match(/^((?:(?:From|To|Cc|Subject|Date|Sent):.*\n)+)\n?([\s\S]*)$/i);
  if (!split) {
    const first = text.split("\n")[0] || "";
    return {
      from: "",
      to: "",
      subject: first.slice(0, 120),
      date: "",
      body: text,
    };
  }
  const headers = split[1];
  return {
    from: headerValue(headers, "From") || headerValue(headers, "Sent"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date") || headerValue(headers, "Sent"),
    body: (split[2] || "").trim() || text,
  };
}

export function parsePastedEmails(raw: string): PastedEmail[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const chunks = text
    .split(/\n(?=From:\s)|(?:\n[-=]{3,}\n)/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return (chunks.length ? chunks : [text]).map(parseOne).filter((email) => email.body || email.subject);
}

export function parseWatchAddresses(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 40);
}
