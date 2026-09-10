import type { GmailInboxMessage } from '../services/emailBriefingService';

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'for',
  'in',
  'on',
  'is',
  'it',
  'this',
  'that',
  'what',
  'when',
  'who',
  'how',
  'can',
  'you',
  'please',
  'about',
  'with',
  'from',
  'they',
  'them',
  'their',
  'we',
  'our',
  'do',
  'does',
  'did',
  'be',
  'was',
  'are',
  'me',
  'my',
  'any',
  'just',
  'need',
  'know',
  'tell',
]);

export type ChatPin =
  | { type: 'message'; id: string; label: string }
  | { type: 'person'; query: string; label: string };

export function questionTerms(question: string): string[] {
  const quoted = [...question.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim().toLowerCase());
  const words = question
    .toLowerCase()
    .split(/[^\w@.+-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP.has(word));
  return [...new Set([...quoted, ...words])].slice(0, 12);
}

export const GMAIL_SHOP_QUERY = '-category:promotions -category:social';
export const SHOP_MAIL_STORAGE_KEY = 'njplumbing.inboxShopMailOnly';

export function gmailSearchQuery(question: string): string {
  const terms = questionTerms(question).slice(0, 8);
  if (!terms.length) return `in:inbox ${GMAIL_SHOP_QUERY}`;
  return `in:inbox ${GMAIL_SHOP_QUERY} {${terms.join(' ')}}`;
}

const PROMO_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']);

const PROMO_FROM = [
  'deals@',
  'offers@',
  'promo@',
  'promotions@',
  'newsletter@',
  'newsletters@',
  'marketing@',
  'facebookmail.com',
  'mail.instagram.com',
  'linkedin.com',
  'pinterest.com',
  'e.twitter.com',
  'email.tiktok.com',
  'nextdoor.com',
  'redditmail.com',
  'spotify.com',
  'netflix.com',
  'mailchimp.com',
  'mailchi.mp',
  'klaviyo.com',
  'constantcontact.com',
  'brevo.com',
  'sendinblue.com',
  'beehiiv.com',
  'substack.com',
];

const PROMO_SUBJECT = [
  /\b\d{1,2}%\s*off\b/i,
  /\bflash sale\b/i,
  /\bexclusive (?:deal|offer)\b/i,
  /\bshop now\b/i,
  /\badvertisement\b/i,
  /\bsponsored\b/i,
  /\bfree shipping\b/i,
  /\bdon'?t miss\b/i,
  /\byou(?:'re| are) missing out\b/i,
  /\bnewsletter\b/i,
  /\bunsubscribe here\b/i,
];

const SHOP_FROM = [
  '1800heaters',
  '1-800-heaters',
  'njplumbing',
  'nj-plumbing',
  'ferguson.com',
  'supplyhouse.com',
  'johnstonesupply',
  'rheem.com',
  'bradfordwhite',
  'aosmith',
  'ao-smith',
  'navien',
  'rinnai',
  'teams.microsoft',
  'microsoft.com',
];

const SHOP_HINT =
  /\b(?:wo[\s#:._-]*\d{5,}|(?:work|sales)[\s_-]*order|water[\s_-]*heater|plumb(?:er|ing)|dispatch|install(?:ation)?|estimate|invoice|job ticket|permit|purchase order|po[\s#:.-]*\d+)\b/i;

export function looksLikeShopEmail(message: {
  from?: string;
  subject?: string;
  snippet?: string;
  body?: string;
}): boolean {
  const from = (message.from || '').toLowerCase();
  if (SHOP_FROM.some((part) => from.includes(part))) return true;
  return SHOP_HINT.test([message.subject, message.snippet, message.body].filter(Boolean).join('\n'));
}

export function isAdvertisement(message: {
  from?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  labels?: string[];
}): boolean {
  if (looksLikeShopEmail(message)) return false;
  const labels = message.labels || [];
  if (labels.some((label) => PROMO_LABELS.has(label))) return true;
  const from = (message.from || '').toLowerCase();
  if (PROMO_FROM.some((part) => from.includes(part))) return true;
  const subject = message.subject || '';
  return PROMO_SUBJECT.some((pattern) => pattern.test(subject));
}

export function readShopMailOnly(): boolean {
  try {
    const raw = localStorage.getItem(SHOP_MAIL_STORAGE_KEY);
    if (raw == null) return true;
    return raw !== '0' && raw !== 'false';
  } catch {
    return true;
  }
}

export function storeShopMailOnly(value: boolean): void {
  try {
    localStorage.setItem(SHOP_MAIL_STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

function haystack(message: GmailInboxMessage): string {
  return [message.from, message.to, message.cc, message.subject, message.snippet, message.body || '']
    .join(' ')
    .toLowerCase();
}

export function scoreInboxMessage(
  message: GmailInboxMessage,
  terms: string[],
  pins: ChatPin[],
  openId?: string
): number {
  let score = 0;
  const text = haystack(message);
  for (const term of terms) {
    if (!text.includes(term)) continue;
    score += term.length > 5 ? 3 : 2;
    if (message.subject.toLowerCase().includes(term)) score += 4;
    if (message.from.toLowerCase().includes(term) || message.to.toLowerCase().includes(term)) {
      score += 5;
    }
  }
  if (openId && message.id === openId) score += 40;
  for (const pin of pins) {
    if (pin.type === 'message' && pin.id === message.id) score += 50;
    if (pin.type === 'person') {
      const needle = pin.query.toLowerCase();
      if (text.includes(needle)) score += 20;
    }
  }
  if (message.unread) score += 1;
  return score;
}

export const CHAT_CONTEXT_MIN = 5;
export const CHAT_CONTEXT_MAX = 80;
export const CHAT_CONTEXT_LIMIT = 40;
export const CHAT_CONTEXT_STORAGE_KEY = 'njplumbing.inboxChatContextLimit';

export function clampChatContextLimit(value: unknown): number {
  if (value == null || value === '') return CHAT_CONTEXT_LIMIT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return CHAT_CONTEXT_LIMIT;
  return Math.min(CHAT_CONTEXT_MAX, Math.max(CHAT_CONTEXT_MIN, Math.round(parsed)));
}

export function pickRelevantMessages(
  messages: GmailInboxMessage[],
  question: string,
  pins: ChatPin[],
  openId?: string,
  limit = CHAT_CONTEXT_LIMIT
): GmailInboxMessage[] {
  const keepIds = new Set<string>();
  if (openId) keepIds.add(openId);
  for (const pin of pins) {
    if (pin.type === 'message') keepIds.add(pin.id);
  }
  const work = messages.filter(
    (message) => keepIds.has(message.id) || !isAdvertisement(message)
  );
  const terms = questionTerms(question);
  const ranked = work
    .map((message) => ({ message, score: scoreInboxMessage(message, terms, pins, openId) }))
    .sort((a, b) => b.score - a.score || Number(b.message.receivedAt || 0) - Number(a.message.receivedAt || 0));
  const picked = new Map<string, GmailInboxMessage>();
  const take = (message?: GmailInboxMessage | null) => {
    if (!message?.id || picked.has(message.id)) return;
    picked.set(message.id, message);
  };
  if (openId) take(work.find((message) => message.id === openId));
  for (const pin of pins) {
    if (pin.type === 'message') take(work.find((message) => message.id === pin.id));
  }
  for (const row of ranked) {
    if (picked.size >= limit) break;
    if (row.score > 0) take(row.message);
  }
  const newest = [...work].sort(
    (left, right) => Number(right.receivedAt || 0) - Number(left.receivedAt || 0)
  );
  for (const message of newest) {
    if (picked.size >= limit) break;
    take(message);
  }
  return [...picked.values()].slice(0, limit);
}

export type AtSuggestion =
  | { kind: 'message'; id: string; label: string; hint: string }
  | { kind: 'person'; query: string; label: string; hint: string };

export function atQuery(input: string): string | null {
  const match = input.match(/@([^\s@]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function applyAtMention(input: string, inserted: string): string {
  return input.replace(/@([^\s@]*)$/, `@${inserted} `);
}
