import { useCallback, useEffect, useState } from 'react';
import type { StoredWorkOrder } from '../types';
import {
  deleteInternalJob,
  listInternalJobsForDate,
  saveInternalJob,
  updateInternalJob,
  type InternalJobInput,
} from '../services/internalJobService';
import './InternalJobs.css';

const JOB_TYPES = [
  'Water heater installation',
  'Water heater repair',
  'Drain cleaning',
  'Toilet repair / replacement',
  'Faucet / fixture',
  'Kitchen / bath remodel',
  'Gas line',
  'Boiler',
  'Sewer / main line',
  'Other',
];

const emptyForm = (date: string): InternalJobInput => ({
  workOrderNumber: '',
  customerName: '',
  phone: '',
  address: '',
  jobType: JOB_TYPES[0],
  appointmentDate: date,
  appointmentTime: '',
  notes: '',
  smsConsent: false,
});

function formFromJob(job: StoredWorkOrder): InternalJobInput {
  return {
    workOrderNumber: job.workOrderNumber,
    customerName: job.customerName,
    phone: job.phone,
    address: job.address,
    jobType: job.jobType,
    appointmentDate: job.appointmentDate,
    appointmentTime: job.appointmentTime,
    notes: job.notes,
    smsConsent: job.smsConsent,
  };
}

interface InternalJobsProps {
  selectedDate: string;
}

export default function InternalJobs({ selectedDate }: InternalJobsProps) {
  const [form, setForm] = useState<InternalJobInput>(() => emptyForm(selectedDate));
  const [jobs, setJobs] = useState<StoredWorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setJobs(await listInternalJobsForDate(selectedDate));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    setForm((current) => ({ ...current, appointmentDate: selectedDate }));
    void reload();
  }, [selectedDate, reload]);

  const resetForm = () => {
    setForm(emptyForm(selectedDate));
    setEditingId(null);
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError('');
    setStatus('');
    try {
      if (editingId) {
        await updateInternalJob(editingId, form);
        setStatus('Job updated. It will appear on Dispatch for this date.');
      } else {
        const { workOrderId } = await saveInternalJob(form);
        setStatus(`Job saved (${workOrderId}). Open Dispatch to assign it to a truck.`);
      }
      resetForm();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (job: StoredWorkOrder) => {
    setEditingId(job.id);
    setForm(formFromJob(job));
    setStatus('');
    setError('');
  };

  const handleDelete = async (job: StoredWorkOrder) => {
    if (!window.confirm(`Remove internal job ${job.workOrderNumber || job.customerName}?`)) return;
    setSaving(true);
    setError('');
    try {
      await deleteInternalJob(job.id);
      if (editingId === job.id) resetForm();
      setStatus('Job removed.');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const updateField = <K extends keyof InternalJobInput>(key: K, value: InternalJobInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="internal-jobs">
      <div className="internal-jobs__toolbar">
        <h2>N&amp;J internal jobs</h2>
        <p>
          Enter direct N&amp;J Plumbing work that is not billed through 1-800 Heaters. Saved jobs
          use the date in the header and show on Dispatch once notes are filled in.
        </p>
      </div>

      {error ? <div className="internal-jobs__error">{error}</div> : null}
      {status ? <div className="internal-jobs__status">{status}</div> : null}

      <section className="internal-jobs__card">
        <h3>{editingId ? 'Edit job' : 'New job'}</h3>
        <div className="internal-jobs__grid">
          <label>
            Work order # <span className="internal-jobs__muted">(optional)</span>
            <input
              value={form.workOrderNumber}
              onChange={(event) => updateField('workOrderNumber', event.target.value)}
              placeholder="Auto-generated if blank"
            />
          </label>
          <label>
            Customer name
            <input
              value={form.customerName}
              onChange={(event) => updateField('customerName', event.target.value)}
              required
            />
          </label>
          <label>
            Phone
            <input
              value={form.phone}
              onChange={(event) => updateField('phone', event.target.value)}
              placeholder="8605551234"
              required
            />
          </label>
          <label>
            Service address
            <input
              value={form.address}
              onChange={(event) => updateField('address', event.target.value)}
              placeholder="Street, town, CT"
              required
            />
          </label>
          <label>
            Job type
            <select
              value={form.jobType}
              onChange={(event) => updateField('jobType', event.target.value)}
            >
              {JOB_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            Appointment date
            <input
              type="date"
              value={form.appointmentDate}
              onChange={(event) => updateField('appointmentDate', event.target.value)}
              required
            />
          </label>
          <label>
            Time <span className="internal-jobs__muted">(optional, HH:MM)</span>
            <input
              type="time"
              value={form.appointmentTime}
              onChange={(event) => updateField('appointmentTime', event.target.value)}
            />
          </label>
          <label className="internal-jobs__full">
            Job notes
            <textarea
              value={form.notes}
              onChange={(event) => updateField('notes', event.target.value)}
              placeholder="Scope, access, parts, callback window… Dispatch moves jobs with notes to Ready."
            />
          </label>
          <label className="internal-jobs__check">
            <input
              type="checkbox"
              checked={form.smsConsent}
              onChange={(event) => updateField('smsConsent', event.target.checked)}
            />
            Customer agreed to appointment texts
          </label>
        </div>
        <div className="internal-jobs__actions">
          <button
            type="button"
            className="internal-jobs__primary"
            disabled={saving}
            onClick={() => void handleSubmit()}
          >
            {saving ? 'Saving…' : editingId ? 'Update job' : 'Save job'}
          </button>
          {editingId ? (
            <button type="button" disabled={saving} onClick={resetForm}>
              Cancel edit
            </button>
          ) : null}
        </div>
      </section>

      <section className="internal-jobs__card">
        <h3>
          Jobs on {selectedDate}
          {loading ? ' · loading…' : ` · ${jobs.length}`}
        </h3>
        {jobs.length === 0 && !loading ? (
          <p className="internal-jobs__muted">No internal jobs for this date yet.</p>
        ) : (
          <div className="internal-jobs__list">
            {jobs.map((job) => (
              <article
                key={job.id}
                className={`internal-jobs__row${editingId === job.id ? ' internal-jobs__row--active' : ''}`}
              >
                <button type="button" className="internal-jobs__row-main" onClick={() => handleEdit(job)}>
                  <strong>{job.customerName || 'Unnamed'}</strong>
                  <small>
                    {job.workOrderNumber ? `WO ${job.workOrderNumber} · ` : ''}
                    {job.jobType}
                    {job.appointmentTime ? ` · ${job.appointmentTime}` : ''}
                    {job.phone ? ` · ${job.phone}` : ''}
                  </small>
                  {job.address ? <small>{job.address}</small> : null}
                  {!job.notes.trim() ? (
                    <small>Add notes so Dispatch can queue this job.</small>
                  ) : null}
                </button>
                <div className="internal-jobs__row-actions">
                  <button type="button" disabled={saving} onClick={() => handleEdit(job)}>
                    Edit
                  </button>
                  <button type="button" disabled={saving} onClick={() => void handleDelete(job)}>
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
