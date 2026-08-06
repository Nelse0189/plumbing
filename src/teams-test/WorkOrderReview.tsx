import type { WorkOrder } from '../types';

interface WorkOrderReviewProps {
  workOrder: WorkOrder;
  status?: 'draft' | 'saving' | 'saved';
  reminderQueued?: boolean;
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
  { key: 'phone', label: 'Phone' },
  { key: 'address', label: 'Address' },
  { key: 'jobType', label: 'Job type' },
  { key: 'appointmentDate', label: 'Job date', type: 'date' },
  { key: 'appointmentTime', label: 'Job time', type: 'time' },
];

export default function WorkOrderReview({
  workOrder,
  status = 'draft',
  reminderQueued,
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
          <strong>Review extracted work order</strong>
          <span>{workOrder.sourceFileName}</span>
        </div>
        {workOrder.confidence !== undefined && (
          <span>{Math.round(workOrder.confidence * 100)}% AI confidence</span>
        )}
      </div>

      <p className="teams-test__review-warning">
        Verify the customer, phone number, job date, and job type before saving.
        Saving adds the job to the schedule and queues its morning text.
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
        <span>Notes</span>
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
          Customer has authorized transactional appointment text messages
        </span>
      </label>

      {error && <p className="teams-test__attachment-error">{error}</p>}

      <button type="button" disabled={status !== 'draft'} onClick={onSave}>
        {status === 'saving'
          ? 'Saving…'
          : status === 'saved'
            ? reminderQueued
              ? 'Saved & reminder queued'
              : 'Saved (no SMS queued)'
            : 'Approve and schedule'}
      </button>
    </article>
  );
}

