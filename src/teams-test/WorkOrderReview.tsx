import type { WorkOrder } from '../types';

interface WorkOrderReviewProps {
  workOrder: WorkOrder;
  status?: 'draft' | 'saving' | 'saved';
  error?: string;
  onChange: (workOrder: WorkOrder) => void;
  onSave: () => void;
}

type EditableWorkOrderField = Exclude<keyof WorkOrder, 'confidence'>;

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
          <strong>Review clean work-order fields</strong>
          <span>{workOrder.sourceFileName}</span>
        </div>
        {workOrder.confidence !== undefined && (
          <span>{Math.round(workOrder.confidence * 100)}% AI confidence</span>
        )}
      </div>

      <p className="teams-test__review-warning">
        Verify the customer, phone number, job date, and job type before saving.
        Saving adds the job to the unscheduled queue and does not text the
        customer.
      </p>

      <div className="teams-test__work-order-grid">
        {fields.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              type={field.type ?? 'text'}
              value={String(workOrder[field.key] ?? '')}
              onChange={(event) => update(field.key, event.target.value)}
            />
          </label>
        ))}
      </div>

      <label className="teams-test__work-order-notes">
        <span>Notes (includes matching Teams channel notes)</span>
        <textarea
          value={workOrder.notes}
          onChange={(event) => update('notes', event.target.value)}
        />
      </label>

      <label className="teams-test__consent">
        <input
          type="checkbox"
          checked={workOrder.smsConsent}
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

      <button type="button" disabled={status !== 'draft'} onClick={onSave}>
        {status === 'saving'
          ? 'Saving…'
          : status === 'saved'
            ? 'Saved as unscheduled'
            : 'Save to unscheduled jobs'}
      </button>
    </article>
  );
}

