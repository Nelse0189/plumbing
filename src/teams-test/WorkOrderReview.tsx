import type { WorkOrder } from '../types';

interface WorkOrderReviewProps {
  workOrder: WorkOrder;
  status?: 'importing' | 'draft' | 'saving' | 'saved';
  cached?: boolean;
  error?: string;
  onChange: (workOrder: WorkOrder) => void;
  onSave: () => void;
}

type EditableWorkOrderField = Exclude<
  keyof WorkOrder,
  | 'confidence'
  | 'teamsTeamId'
  | 'teamsChannelId'
  | 'teamsMessageId'
  | 'teamsAttachmentId'
>;

const fields: Array<{
  key: EditableWorkOrderField;
  label: string;
  type?: string;
}> = [
  { key: 'workOrderNumber', label: 'Work order number' },
  { key: 'customerName', label: 'Customer name' },
  { key: 'phone', label: 'Phone number' },
  { key: 'address', label: 'Service address' },
  { key: 'jobType', label: 'Installation / job type' },
  { key: 'appointmentDate', label: 'Requested date', type: 'date' },
  { key: 'appointmentTime', label: 'Requested time', type: 'time' },
];

export default function WorkOrderReview({
  workOrder,
  status = 'draft',
  cached = false,
  error,
  onChange,
  onSave,
}: WorkOrderReviewProps) {
  const update = (key: EditableWorkOrderField, value: string) => {
    onChange({ ...workOrder, [key]: value });
  };

  return (
    <article className="teams-test__work-order">
      <div className="teams-test__work-order-title">
        <div>
          <strong>Work order from Teams PDF</strong>
          <span>{workOrder.sourceFileName}</span>
        </div>
        <span>
          {status === 'importing'
            ? 'Importing…'
            : cached
              ? 'Firebase cache'
              : status === 'saved'
                ? 'Saved in Firebase'
                : 'Needs review'}
          {workOrder.confidence !== undefined
            ? ` · ${Math.round(workOrder.confidence * 100)}% AI confidence`
            : ''}
        </span>
      </div>

      <p className="teams-test__review-warning">
        This job was imported automatically and saved in Firebase. Verify the
        customer, phone, date, and job type before scheduling texts.
      </p>

      <div className="teams-test__work-order-grid">
        {fields.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              type={field.type ?? 'text'}
              value={String(workOrder[field.key] ?? '')}
              disabled={status === 'importing' || status === 'saving'}
              onChange={(event) => update(field.key, event.target.value)}
            />
          </label>
        ))}
      </div>

      <label className="teams-test__work-order-notes">
        <span>Notes (includes matching Teams channel notes)</span>
        <textarea
          value={workOrder.notes}
          disabled={status === 'importing' || status === 'saving'}
          onChange={(event) => update('notes', event.target.value)}
        />
      </label>

      <label className="teams-test__consent">
        <input
          type="checkbox"
          checked={workOrder.smsConsent}
          disabled={status === 'importing' || status === 'saving'}
          onChange={(event) =>
            onChange({ ...workOrder, smsConsent: event.target.checked })
          }
        />
        <span>
          Customer said “Yes” to the NJ Plumbing verbal SMS script (v1.0)
        </span>
      </label>
      <p className="teams-test__hint">
        Ask: “May NJ Plumbing send you automated text messages about
        scheduling, reminders, and arrival windows for this job? Message
        frequency varies. Message and data rates may apply. Reply STOP to opt
        out. Consent is not required to receive service. Is that okay?”
      </p>

      {error && <p className="teams-test__attachment-error">{error}</p>}

      <button
        type="button"
        disabled={status === 'importing' || status === 'saving'}
        onClick={onSave}
      >
        {status === 'saving'
          ? 'Saving…'
          : status === 'saved'
            ? 'Update Firebase job'
            : 'Save corrections to Firebase'}
      </button>
    </article>
  );
}
