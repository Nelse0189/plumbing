import { locateScheduleEvidenceQuote } from '../utils/teamsAppointmentDate';

export default function NotesWithScheduleHighlight({
  notes,
  scheduleDate,
  evidenceQuote,
  className,
}: {
  notes: string;
  scheduleDate?: string;
  evidenceQuote?: string;
  className?: string;
}) {
  const evidence = locateScheduleEvidenceQuote(notes, evidenceQuote);

  if (!evidence) {
    return <pre className={className}>{notes}</pre>;
  }

  return (
    <pre className={className}>
      {notes.slice(0, evidence.start)}
      <mark
        className="schedule-date-mark"
        title={
          scheduleDate
            ? `Scheduled from this note for ${scheduleDate}`
            : 'Scheduled from this note'
        }
      >
        {notes.slice(evidence.start, evidence.end)}
      </mark>
      {notes.slice(evidence.end)}
    </pre>
  );
}
