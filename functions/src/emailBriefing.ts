import OpenAI from "openai";
import { HttpsError, onCall } from "firebase-functions/v2/https";

const MAX_EMAILS = 80;
const MAX_BODY = 6000;
const MAX_TOTAL = 220000;
const OPENAI_SHORT_CONTEXT_LIMIT = 272000;
const OPENAI_RATES: Record<string, { input: number; cached: number; output: number; longInput: number; longCached: number; longOutput: number }> = {
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12, longInput: 4, longCached: 0.4, longOutput: 18 },
  "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30, longInput: 10, longCached: 1, longOutput: 45 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2, longInput: 0.4, longCached: 0.04, longOutput: 1.8 },
};

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function costFromUsage(
  model: string,
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  }
) {
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens || 0;
  const rates =
    OPENAI_RATES[model.replace(/\s+/g, "-").toLowerCase()] || OPENAI_RATES["gpt-5.6-sol"];
  const long = promptTokens > OPENAI_SHORT_CONTEXT_LIMIT;
  const uncached = Math.max(0, promptTokens - cachedTokens);
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: roundUsd(
      (uncached * (long ? rates.longInput : rates.input) +
        cachedTokens * (long ? rates.longCached : rates.cached) +
        completionTokens * (long ? rates.longOutput : rates.output)) /
        1_000_000
    ),
    model,
  };
}

export interface OfficeEmailInput {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonObject(text: string): Record<string, unknown> {
  const withoutFences = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("AI response did not contain a JSON object");
  }
  return JSON.parse(withoutFences.slice(start, end + 1)) as Record<string, unknown>;
}

function readEmails(raw: unknown): OfficeEmailInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_EMAILS)
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        from: asText(row.from).slice(0, 200),
        to: asText(row.to).slice(0, 200),
        subject: asText(row.subject).slice(0, 300),
        date: asText(row.date).slice(0, 80),
        body: asText(row.body).slice(0, MAX_BODY),
      };
    })
    .filter((email) => email.body || email.subject);
}

function readAddresses(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => asText(value).toLowerCase())
    .filter((value) => value.includes("@"))
    .slice(0, 40);
}

export async function runOfficeEmailBriefing(
  emails: OfficeEmailInput[],
  watch: string[]
): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "OPENAI_API_KEY is not configured");
  }
  if (!emails.length) {
    throw new HttpsError("invalid-argument", "No emails to summarize.");
  }
  const packed = JSON.stringify({ watch, emails });
  if (packed.length > MAX_TOTAL) {
    throw new HttpsError("invalid-argument", "That email set is too large. Process fewer messages.");
  }
  const client = new OpenAI({ apiKey });
  const result = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You summarize plumbing-shop email for N&J Plumbing (Berlin, CT) and 1-800 Heaters work.",
          "Write for the office: short, specific, no fluff.",
          "If watchAddresses is provided, pay extra attention to those senders/recipients and say when a message is outside that set.",
          "Do not invent jobs, money, or promises that are not in the emails.",
          "Return JSON only:",
          "{",
          '  "headline": string,',
          '  "briefing": string[],',
          '  "actions": string[],',
          '  "money": string[],',
          '  "scheduling": string[],',
          '  "emails": [{ "from": string, "subject": string, "urgency": "high"|"normal"|"low", "summary": string, "action": string }]',
          "}",
        ].join("\n"),
      },
      { role: "user", content: packed },
    ],
  });
  const content = result.choices[0]?.message.content;
  if (!content) {
    throw new HttpsError("internal", "OpenAI returned an empty response");
  }
  return parseJsonObject(content);
}

export const askAboutOfficeEmail = onCall(
  {
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
    invoker: "public",
  },
  async (request) => {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "OPENAI_API_KEY is not configured");
    }
    const data = request.data && typeof request.data === "object" ? request.data : {};
    const question = asText((data as { question?: unknown }).question).slice(0, 2000);
    const emails = readEmails((data as { emails?: unknown }).emails);
    const pasted = asText((data as { email?: unknown }).email).slice(0, 20000);
    if (pasted) {
      emails.push({ from: "", to: "", subject: "Extra pasted text", date: "", body: pasted });
    }
    if (!emails.length) {
      throw new HttpsError(
        "invalid-argument",
        "No inbox context yet. Open a message, load the inbox, or paste an email."
      );
    }
    if (!question) {
      throw new HttpsError("invalid-argument", "Ask a question about the inbox.");
    }
    const packed = emails
      .map((item, index) =>
        [
          `EMAIL ${index + 1}`,
          item.from ? `From: ${item.from}` : "",
          item.to ? `To: ${item.to}` : "",
          item.date ? `Date: ${item.date}` : "",
          item.subject ? `Subject: ${item.subject}` : "",
          "",
          item.body,
        ]
          .filter((line, lineIndex, lines) => line || lines[lineIndex + 1])
          .join("\n")
      )
      .join("\n\n-----\n\n")
      .slice(0, MAX_TOTAL);
    const historyRaw = (data as { history?: unknown }).history;
    const history = Array.isArray(historyRaw)
      ? historyRaw
          .slice(-12)
          .map((item) => {
            const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const role = asText(row.role) === "assistant" ? "assistant" : "user";
            return { role: role as "user" | "assistant", content: asText(row.content).slice(0, 4000) };
          })
          .filter((item) => item.content)
      : [];

    const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
    const client = new OpenAI({ apiKey });
    const result = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: [
            "You help N&J Plumbing office staff using emails retrieved from their inbox.",
            "Treat the supplied emails like relevant files in an editor: use them, cite which ones you used (from + subject), and do not invent mail that is not here.",
            "Advertisements and social promotions were already removed. Ignore leftover marketing copy.",
            "Email 1 is usually the message they have open or pinned. Later emails were retrieved because they matched the question or are recent work mail.",
            "Be short and specific: money, dates, names, addresses, what they want, what to do next.",
            "If the retrieved mail does not answer it, say so and name what is missing.",
          ].join(" "),
        },
        {
          role: "user",
          content: `INBOX CONTEXT:\n${packed}`,
        },
        ...history,
        { role: "user", content: question },
      ],
    });
    const answer = asText(result.choices[0]?.message.content);
    if (!answer) {
      throw new HttpsError("internal", "OpenAI returned an empty response");
    }
    return {
      answer,
      used: emails.map((item) => ({
        from: item.from,
        subject: item.subject,
      })),
      usage: costFromUsage(result.model || model, result.usage),
    };
  }
);

export const summarizeOfficeEmails = onCall(
  {
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
    invoker: "public",
  },
  async (request) => {
    const data = request.data && typeof request.data === "object" ? request.data : {};
    const emails = readEmails((data as { emails?: unknown }).emails);
    const watch = readAddresses((data as { watchAddresses?: unknown }).watchAddresses);
    if (!emails.length) {
      throw new HttpsError("invalid-argument", "Paste or drop at least one email.");
    }
    return {
      result: await runOfficeEmailBriefing(emails, watch),
    };
  }
);
