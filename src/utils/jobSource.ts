export const JOB_SOURCES = [
  'home_depot',
  'lowes',
  'n_and_j_in_house',
  'not_tied_to_a_job',
] as const;

export type JobSource = (typeof JOB_SOURCES)[number];

export const JOB_SOURCE_LABELS: Record<JobSource, string> = {
  home_depot: 'Home Depot',
  lowes: "Lowe's",
  n_and_j_in_house: 'N and J in-house',
  not_tied_to_a_job: 'Not tied to a job',
};

export function isJobSource(value: string | undefined | null): value is JobSource {
  return Boolean(value && (JOB_SOURCES as readonly string[]).includes(value));
}

export function jobSourceLabel(source?: string | null): string {
  if (!source) return '';
  if (isJobSource(source)) return JOB_SOURCE_LABELS[source];
  return source;
}
