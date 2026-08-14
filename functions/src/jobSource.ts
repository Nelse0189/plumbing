export const JOB_SOURCES = [
  "home_depot",
  "lowes",
  "n_and_j_in_house",
  "not_tied_to_a_job",
] as const;

export type JobSource = (typeof JOB_SOURCES)[number];

export const JOB_SOURCE_LABELS: Record<JobSource, string> = {
  home_depot: "Home Depot",
  lowes: "Lowe's",
  n_and_j_in_house: "N and J in-house",
  not_tied_to_a_job: "Not tied to a job",
};

const RAW_ALIASES: Record<string, JobSource> = {
  home_depot: "home_depot",
  homedepot: "home_depot",
  home_depot_job: "home_depot",
  hd: "home_depot",
  depot: "home_depot",
  the_depot: "home_depot",
  lowes: "lowes",
  lowe_s: "lowes",
  "lowe's": "lowes",
  lowes_job: "lowes",
  n_and_j_in_house: "n_and_j_in_house",
  n_and_j: "n_and_j_in_house",
  n_j: "n_and_j_in_house",
  nj_in_house: "n_and_j_in_house",
  in_house: "n_and_j_in_house",
  inhouse: "n_and_j_in_house",
  company_job: "n_and_j_in_house",
  not_tied_to_a_job: "not_tied_to_a_job",
  not_tied: "not_tied_to_a_job",
  none: "not_tied_to_a_job",
  unknown: "not_tied_to_a_job",
  unmarked: "not_tied_to_a_job",
};

function normalizedTranscript(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\u00a0/g, " ");
}

function withoutNegated(text: string, pattern: RegExp): string {
  return text.replace(pattern, " ");
}

export function mentionsHomeDepot(transcript: string): boolean {
  const text = withoutNegated(
    normalizedTranscript(transcript),
    /\bnot\s+(an?\s+|from\s+|through\s+|with\s+)?(home\s*depot|the depot)\b/g
  );
  return (
    /\bhome\s*depot\b/.test(text) ||
    /\bthe depot\b/.test(text) ||
    /\bh[\s.]*d[\s.]*(job|work\s*order|po|p\.o\.?|install|order)/.test(text) ||
    /\b(job|work\s*order|po|p\.o\.?|install|order)\s+(from\s+|through\s+|at\s+|for\s+)?h[\s.]*d\b/.test(
      text
    )
  );
}

export function mentionsLowes(transcript: string): boolean {
  const text = withoutNegated(
    normalizedTranscript(transcript),
    /\bnot\s+(an?\s+|from\s+|through\s+|with\s+)?lowe'?s\b/g
  );
  return /\blowe'?s\b/.test(text);
}

export function mentionsNAndJInHouse(transcript: string): boolean {
  const text = withoutNegated(
    normalizedTranscript(transcript),
    /\bnot\s+(an?\s+)?in[\s-]*house\b/g
  );
  return (
    /\bin[\s-]*house\b/.test(text) ||
    /\bour own (job|customer|work)\b/.test(text) ||
    /\b(company|direct)\s+(job|customer|work)\b/.test(text) ||
    /\bn\s*(and|&)\s*j(?:\s+plumbing)?\s+(in[\s-]*house|direct|company)(?:\s+job|\s+work\s*order)?/.test(
      text
    ) ||
    /\bn\s*(and|&)\s*j(?:\s+plumbing)?\s+job\b/.test(text)
  );
}

function mapRawJobSource(rawSource: unknown): JobSource {
  if (typeof rawSource !== "string") return "not_tied_to_a_job";
  const value = rawSource.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return RAW_ALIASES[value] || "not_tied_to_a_job";
}

/**
 * Classify the store/program for a call. Store names win when mentioned.
 * A greeting like "N and J Plumbing" is not enough for in-house.
 * If nothing qualifying is mentioned, the call is not tied to a job.
 */
export function resolveJobSource(rawSource: unknown, transcript: string): JobSource {
  const hd = mentionsHomeDepot(transcript);
  const lowes = mentionsLowes(transcript);
  const inHouse = mentionsNAndJInHouse(transcript);
  const mapped = mapRawJobSource(rawSource);

  if (hd && !lowes) return "home_depot";
  if (lowes && !hd) return "lowes";
  if (hd && lowes) {
    if (mapped === "home_depot" || mapped === "lowes") return mapped;
    return "not_tied_to_a_job";
  }
  if (inHouse) return "n_and_j_in_house";
  return "not_tied_to_a_job";
}

function snippetAroundMatch(transcript: string, pattern: RegExp): string {
  const match = pattern.exec(transcript);
  if (!match || match.index == null) return "";
  const start = Math.max(0, match.index - 40);
  const end = Math.min(transcript.length, match.index + match[0].length + 40);
  return transcript.slice(start, end).replace(/\s+/g, " ").trim();
}

export function jobSourceEvidenceQuote(
  transcript: string,
  source: JobSource,
  modelQuote?: string
): string {
  if (source === "not_tied_to_a_job") return "";
  const quote = (modelQuote || "").trim();
  if (quote && transcript.toLowerCase().includes(quote.toLowerCase())) {
    return quote.slice(0, 180);
  }
  const text = transcript;
  if (source === "home_depot") {
    return snippetAroundMatch(text, /home\s*depot|the depot|\bh[\s.]*d\b/i);
  }
  if (source === "lowes") {
    return snippetAroundMatch(text, /lowe'?s/i);
  }
  return snippetAroundMatch(
    text,
    /in[\s-]*house|n\s*(and|&)\s*j.{0,24}job|our own (job|customer)|company job|direct (job|customer)/i
  );
}

export function jobSourceLabel(source: JobSource): string {
  return JOB_SOURCE_LABELS[source];
}

function assertEqual(actual: JobSource, expected: JobSource, sample: string): void {
  if (actual !== expected) {
    throw new Error(`job source: expected ${expected} for "${sample}", got ${actual}`);
  }
}

export function runJobSourceSelfChecks(): void {
  assertEqual(
    resolveJobSource("not_tied_to_a_job", "Thanks for calling N and J Plumbing, how can I help you today?"),
    "not_tied_to_a_job",
    "company greeting only"
  );
  assertEqual(
    resolveJobSource("home_depot", "This is a Home Depot water heater install at 12 Main."),
    "home_depot",
    "home depot mentioned"
  );
  assertEqual(
    resolveJobSource("lowes", "The customer said it is a Lowe's job, PO 4412."),
    "lowes",
    "lowes mentioned"
  );
  assertEqual(
    resolveJobSource("n_and_j_in_house", "This one is an in-house N and J job, not through a store."),
    "n_and_j_in_house",
    "in-house mentioned"
  );
  assertEqual(
    resolveJobSource("home_depot", "We can come Tuesday morning to look at the leak."),
    "not_tied_to_a_job",
    "model guessed without mention"
  );
  assertEqual(
    resolveJobSource("n_and_j_in_house", "Thanks for calling N and J Plumbing."),
    "not_tied_to_a_job",
    "in-house guess from greeting"
  );
  assertEqual(
    resolveJobSource("not_tied_to_a_job", "It's not a Home Depot job, this is in-house."),
    "n_and_j_in_house",
    "negated depot plus in-house"
  );
  assertEqual(
    resolveJobSource("lowes", "Not Home Depot — it's a Lowe's install."),
    "lowes",
    "negated depot plus lowes"
  );
}

if (require.main === module) {
  runJobSourceSelfChecks();
  console.log("jobSource self-checks passed");
}
