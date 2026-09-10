import { useEffect, useMemo, useState } from 'react';
import type { DispatchStop, JobTicket } from '../types';
import { subscribeDispatchPlan } from '../services/dispatchService';
import {
  appendJobTicketAudit,
  deleteJobTicket,
  emptyJobTicket,
  findJobTicketForStop,
  jobTicketIsSigned,
  subscribeJobTickets,
  subscribeJobTicketsForWorkOrders,
  suggestedTotal,
} from '../services/jobTicketService';
import { downloadJobTicketsPdf, jobTicketsPdfFileName, printJobTicketsPdf } from '../utils/jobTicketPdf';
import { workOrderHref } from '../utils/workOrderPage';
import JobTicketEditor, { ticketFromStop } from './JobTicketEditor';
import './JobTicket.css';

function addDaysToIsoDate(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + offset));
  return next.toISOString().slice(0, 10);
}

function formatTicketDay(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`));
}

function stopSelectionKey(stop: DispatchStop, existing?: JobTicket) {
  return existing ? `ticket:${existing.id}` : `stop:${stop.id}`;
}

function ticketSelectionKey(ticket: JobTicket) {
  return `ticket:${ticket.id}`;
}

function toggleKey(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function setKeysSelected(current: Set<string>, keys: string[], selected: boolean): Set<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (selected) next.add(key);
    else next.delete(key);
  }
  return next;
}

interface JobTicketPageProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  customerSign: boolean;
  onCustomerSignChange: (sign: boolean) => void;
}

export default function JobTicketPage({
  selectedDate,
  onSelectDate,
  customerSign,
  onCustomerSignChange,
}: JobTicketPageProps) {
  const requestedId = new URLSearchParams(window.location.search).get('ticket') || '';
  const [editorKey, setEditorKey] = useState(requestedId || 'new');
  const [initialTicket, setInitialTicket] = useState<Omit<JobTicket, 'id'> & { id?: string }>(() =>
    requestedId ? { ...emptyJobTicket(selectedDate), id: requestedId } : emptyJobTicket(selectedDate)
  );
  const [sourceStop, setSourceStop] = useState<DispatchStop | undefined>();
  const [tickets, setTickets] = useState<JobTicket[]>([]);
  const [workOrderTickets, setWorkOrderTickets] = useState<JobTicket[]>([]);
  const [stops, setStops] = useState<DispatchStop[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<JobTicket | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState('');

  useEffect(() => {
    return subscribeJobTickets(setTickets, (err) => setError(err.message));
  }, []);

  useEffect(() => {
    return subscribeDispatchPlan(
      selectedDate,
      (plan) => {
        setStops([...plan.trucks.flatMap((truck) => truck.stops), ...plan.unassigned]);
      },
      (err) => setError(err.message)
    );
  }, [selectedDate]);

  useEffect(() => {
    const numbers = stops.map((stop) => stop.workOrderNumber).filter(Boolean);
    const ids = stops.flatMap((stop) => [stop.workOrderId, stop.id].filter(Boolean));
    return subscribeJobTicketsForWorkOrders(numbers, ids, setWorkOrderTickets, (err) =>
      setError(err.message)
    );
  }, [stops]);

  const allTickets = useMemo(() => {
    const merged = new Map<string, JobTicket>();
    for (const ticket of [...tickets, ...workOrderTickets]) merged.set(ticket.id, ticket);
    return [...merged.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [tickets, workOrderTickets]);

  const dayJobKeys = useMemo(
    () => stops.map((stop) => stopSelectionKey(stop, findJobTicketForStop(allTickets, stop))),
    [stops, allTickets]
  );
  const savedTicketKeys = useMemo(
    () => allTickets.map((ticket) => ticketSelectionKey(ticket)),
    [allTickets]
  );
  const allDaySelected = dayJobKeys.length > 0 && dayJobKeys.every((key) => selectedKeys.has(key));
  const someDaySelected = dayJobKeys.some((key) => selectedKeys.has(key));
  const allSavedSelected =
    savedTicketKeys.length > 0 && savedTicketKeys.every((key) => selectedKeys.has(key));
  const someSavedSelected = savedTicketKeys.some((key) => selectedKeys.has(key));
  const selectedCount = selectedKeys.size;

  const resolveSelectedTickets = () => {
    const out: Array<Omit<JobTicket, 'id'> & { id?: string }> = [];
    const seen = new Set<string>();
    for (const stop of stops) {
      const existing = findJobTicketForStop(allTickets, stop);
      const key = stopSelectionKey(stop, existing);
      if (!selectedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(existing || ticketFromStop(stop, selectedDate));
    }
    for (const ticket of allTickets) {
      const key = ticketSelectionKey(ticket);
      if (!selectedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(ticket);
    }
    return out;
  };

  const visibleDates = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDaysToIsoDate(selectedDate, index - 2)),
    [selectedDate]
  );

  useEffect(() => {
    if (initialTicket.id || !sourceStop) return;
    const existing = findJobTicketForStop(allTickets, sourceStop);
    if (!existing) return;
    setInitialTicket(existing);
    setSourceStop(undefined);
    setEditorKey(existing.id);
    onCustomerSignChange(false);
    history.replaceState(null, '', workOrderHref({ ticket: existing.id }));
  }, [allTickets, sourceStop, initialTicket.id, onCustomerSignChange]);

  const resetEditor = (next: Omit<JobTicket, 'id'> & { id?: string }, key: string, stop?: DispatchStop) => {
    setInitialTicket(next);
    setSourceStop(stop);
    setEditorKey(key);
    onCustomerSignChange(false);
  };

  const openTicket = (next: JobTicket) => {
    resetEditor(next, next.id);
    history.replaceState(null, '', workOrderHref({ ticket: next.id }));
  };

  const startFromStop = (stop: DispatchStop) => {
    const existing = findJobTicketForStop(allTickets, stop);
    if (existing) {
      if (existing.id !== editorKey) openTicket(existing);
      return;
    }
    resetEditor(ticketFromStop(stop, selectedDate), `stop-${stop.id}`, stop);
    history.replaceState(null, '', workOrderHref());
  };

  const confirmDeleteTicket = async () => {
    if (!pendingDelete) return;
    setSaving(true);
    setError('');
    try {
      await appendJobTicketAudit(pendingDelete.id, 'deleted', {}).catch(() => undefined);
      await deleteJobTicket(pendingDelete.id);
      if (pendingDelete.id === editorKey || pendingDelete.id === initialTicket.id) {
        resetEditor(emptyJobTicket(selectedDate), `new-${Date.now()}`);
        history.replaceState(null, '', workOrderHref());
      }
      setSelectedKeys((current) => {
        const next = new Set(current);
        next.delete(ticketSelectionKey(pendingDelete));
        return next;
      });
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const printSelectedTickets = async () => {
    const selected = resolveSelectedTickets();
    if (!selected.length) {
      setError('Check the jobs you want to print.');
      return;
    }
    setError('');
    setBulkBusy(`Opening ${selected.length} work order${selected.length === 1 ? '' : 's'} for print preview…`);
    try {
      await printJobTicketsPdf(
        selected,
        jobTicketsPdfFileName(selectedDate, selected.length),
        selected.map((ticket) => ticket.totalAmount || suggestedTotal(ticket))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy('');
    }
  };

  const downloadSelectedTickets = async () => {
    const selected = resolveSelectedTickets();
    if (!selected.length) {
      setError('Check the jobs you want to print.');
      return;
    }
    setError('');
    setBulkBusy(`Building PDF of ${selected.length} work order${selected.length === 1 ? '' : 's'}…`);
    try {
      await downloadJobTicketsPdf(
        selected,
        jobTicketsPdfFileName(selectedDate, selected.length),
        selected.map((ticket) => ticket.totalAmount || suggestedTotal(ticket))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy('');
    }
  };

  const editor = (
    <JobTicketEditor
      key={editorKey}
      serviceDate={selectedDate}
      initialTicket={initialTicket}
      sourceStop={sourceStop}
      updateUrl
      customerSign={customerSign}
      onCustomerSignChange={onCustomerSignChange}
      initialSignOpen={customerSign && editorKey === requestedId}
      onDeleted={() => {
        resetEditor(emptyJobTicket(selectedDate), `new-${Date.now()}`);
        history.replaceState(null, '', workOrderHref());
      }}
    />
  );

  if (customerSign) {
    return editor;
  }

  return (
    <div className="job-ticket">
      <section className="job-ticket__days" aria-label="Service day">
        {visibleDates.map((date) => (
          <button
            key={date}
            type="button"
            className={`job-ticket__day ${date === selectedDate ? 'job-ticket__day--selected' : ''}`}
            onClick={() => onSelectDate(date)}
          >
            <strong>{formatTicketDay(date)}</strong>
            {date === selectedDate ? <span>Selected</span> : <span>View jobs</span>}
          </button>
        ))}
        <label className="job-ticket__day-jump">
          Jump to date
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => onSelectDate(event.target.value)}
          />
        </label>
      </section>
      <div className="job-ticket__sidebar">
        <section className="job-ticket__bulk-bar">
          <h2>Permit packet</h2>
          <p className="job-ticket__muted">
            {selectedCount
              ? `${selectedCount} job${selectedCount === 1 ? '' : 's'} checked`
              : 'Check jobs below, then print. A PDF preview opens so you can send it to the printer.'}
          </p>
          {bulkBusy ? <p className="job-ticket__ok">{bulkBusy}</p> : null}
          <div className="job-ticket__bulk-actions">
            <button
              type="button"
              onClick={() => void printSelectedTickets()}
              disabled={!selectedCount || Boolean(bulkBusy)}
            >
              Print selected
            </button>
            <button
              type="button"
              onClick={() => void downloadSelectedTickets()}
              disabled={!selectedCount || Boolean(bulkBusy)}
            >
              Download PDF
            </button>
            <button
              type="button"
              onClick={() => setSelectedKeys(new Set())}
              disabled={!selectedCount || Boolean(bulkBusy)}
            >
              Clear checks
            </button>
          </div>
        </section>
        <section>
          <h2>
            <label className="job-ticket__select-all">
              <input
                type="checkbox"
                checked={allDaySelected}
                ref={(node) => {
                  if (node) node.indeterminate = someDaySelected && !allDaySelected;
                }}
                disabled={dayJobKeys.length === 0}
                onChange={() =>
                  setSelectedKeys((current) => setKeysSelected(current, dayJobKeys, !allDaySelected))
                }
              />
              Jobs · {formatTicketDay(selectedDate)}
            </label>
          </h2>
          {stops.length === 0 ? (
            <p className="job-ticket__muted">No dispatch jobs for this date.</p>
          ) : (
            <ul>
              {stops.map((stop) => {
                const existing = findJobTicketForStop(allTickets, stop);
                const signed = existing ? jobTicketIsSigned(existing) : false;
                const key = stopSelectionKey(stop, existing);
                return (
                  <li key={stop.id} className="job-ticket__job-row">
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(key)}
                      onChange={() => setSelectedKeys((current) => toggleKey(current, key))}
                      aria-label={`Select ${stop.customerName || 'job'} for printing`}
                    />
                    <button type="button" onClick={() => startFromStop(stop)}>
                      <strong>{stop.customerName || 'Customer'}</strong>
                      <span>{stop.address}</span>
                      <span>{stop.workOrderNumber}</span>
                      {existing ? (
                        <span className={signed ? 'job-ticket__job-signed' : 'job-ticket__job-saved'}>
                          {signed ? 'Signed' : 'Saved'}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section>
          <h2>
            <label className="job-ticket__select-all">
              <input
                type="checkbox"
                checked={allSavedSelected}
                ref={(node) => {
                  if (node) node.indeterminate = someSavedSelected && !allSavedSelected;
                }}
                disabled={savedTicketKeys.length === 0}
                onChange={() =>
                  setSelectedKeys((current) =>
                    setKeysSelected(current, savedTicketKeys, !allSavedSelected)
                  )
                }
              />
              Saved tickets
            </label>
          </h2>
          {allTickets.length === 0 ? (
            <p className="job-ticket__muted">No tickets yet.</p>
          ) : (
            <ul>
              {allTickets.map((saved) => {
                const key = ticketSelectionKey(saved);
                return (
                  <li key={saved.id} className="job-ticket__saved-item">
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(key)}
                      onChange={() => setSelectedKeys((current) => toggleKey(current, key))}
                      aria-label={`Select ${saved.customerName || 'untitled ticket'} for printing`}
                    />
                    <button type="button" onClick={() => openTicket(saved)}>
                      <strong>{saved.customerName || 'Untitled ticket'}</strong>
                      <span>{saved.status === 'signed' ? 'Signed' : 'Draft'}</span>
                      <span>{saved.workOrderNumber}</span>
                    </button>
                    <button
                      type="button"
                      className="job-ticket__saved-delete"
                      aria-label={`Delete ticket for ${saved.customerName || 'untitled ticket'}`}
                      onClick={() => setPendingDelete(saved)}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {editor}
      {error ? <p className="job-ticket__error">{error}</p> : null}
      {pendingDelete ? (
        <div
          className="job-ticket__confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="job-ticket-delete-title"
        >
          <button
            type="button"
            className="job-ticket__confirm-backdrop"
            aria-label="Cancel delete"
            onClick={() => setPendingDelete(null)}
          />
          <div className="job-ticket__confirm-card">
            <p id="job-ticket-delete-title" className="job-ticket__confirm-title">
              Delete this ticket?
            </p>
            <p className="job-ticket__confirm-hint">
              This permanently removes{' '}
              <strong>{pendingDelete.customerName || 'Untitled ticket'}</strong>
              {pendingDelete.workOrderNumber ? ` · WO ${pendingDelete.workOrderNumber}` : ''}.
            </p>
            <div className="job-ticket__confirm-actions">
              <button type="button" onClick={() => setPendingDelete(null)} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="job-ticket__confirm-delete"
                onClick={() => void confirmDeleteTicket()}
                disabled={saving}
              >
                {saving ? 'Deleting…' : 'Delete ticket'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
