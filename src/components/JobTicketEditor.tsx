import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobTicket, JobTicketAuditEvent, JobTicketMaterial } from '../types';
import {
  appendJobTicketAudit,
  createJobTicket,
  deleteJobTicket,
  emptyJobTicket,
  saveJobTicket,
  subscribeJobTicket,
  subscribeJobTicketAudit,
  suggestedTotal,
  summarizeHeaterType,
  ticketAuditDiff,
  ticketAuditSnapshot,
} from '../services/jobTicketService';
import {
  clampWoFontSize,
  combinedAddress,
  MAX_WO_FONT_SIZE,
  MIN_WO_FONT_SIZE,
  parseJobAddress,
} from '../utils/heatersWorkOrder';
import { downloadJobTicketPdf, printJobTicketPdf } from '../utils/jobTicketPdf';
import { workOrderHref } from '../utils/workOrderPage';
import {
  heaterModelFromDescription,
  heaterTypeLabel,
  heaterTypeNeedsAi,
} from '../utils/heaterInstallDescription';
import HeatersWorkOrderForm from './HeatersWorkOrderForm';
import SignaturePad from './SignaturePad';
import './JobTicket.css';

export type TicketStopSource = {
  workOrderId?: string;
  workOrderNumber?: string;
  customerName?: string;
  phone?: string;
  address?: string;
  jobType?: string;
  notes?: string;
  installDescription?: string;
};

function formatSignedAt(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function auditActionLabel(action: JobTicketAuditEvent['action']) {
  if (action === 'created') return 'Created';
  if (action === 'signed') return 'Customer signed';
  if (action === 'amended') return 'Edited after signing';
  if (action === 'deleted') return 'Deleted';
  return 'Saved';
}

function withAutoSignature<T extends Omit<JobTicket, 'id'> & { id?: string }>(ticket: T): T {
  const hasSignature = Boolean(ticket.customerSignature);
  const hasInitial = Boolean(ticket.customerInitial);
  if (hasSignature && hasInitial) {
    return {
      ...ticket,
      customerSignedName: ticket.customerSignedName || ticket.customerName,
      authorizationAccepted: true,
      status: 'signed',
      signedAt: ticket.signedAt || new Date().toISOString(),
    };
  }
  if (ticket.status === 'signed' && (!hasSignature || !hasInitial)) {
    return {
      ...ticket,
      authorizationAccepted: false,
      status: 'draft',
      signedAt: undefined,
    };
  }
  return ticket;
}

function rawInstallText(stop: TicketStopSource): string {
  return stop.installDescription || stop.notes || stop.jobType || '';
}

export function ticketFromStop(stop: TicketStopSource, serviceDate: string): Omit<JobTicket, 'id'> {
  const parts = parseJobAddress(stop.address || '');
  const blank = emptyJobTicket(serviceDate);
  const heaterType = heaterTypeLabel(rawInstallText(stop));
  const materials = blank.materials.map((row, index) => ({
    ...row,
    description: index === 0 ? heaterType : '',
    amount: '',
  }));
  return {
    ...blank,
    workOrderId: stop.workOrderId || '',
    workOrderNumber: stop.workOrderNumber || '',
    customerName: stop.customerName || '',
    phone: stop.phone || '',
    address: stop.address || '',
    street: parts.street,
    city: parts.city,
    zip: parts.zip,
    jobType: stop.jobType || '',
    heaterModel: heaterModelFromDescription(heaterType || rawInstallText(stop)),
    materials,
  };
}

function SignPopup({
  ticket,
  status,
  onChange,
  onClose,
}: {
  ticket: Omit<JobTicket, 'id'> & { id?: string };
  status: string;
  onChange: <K extends keyof JobTicket>(key: K, value: JobTicket[K]) => void;
  onClose: () => void;
}) {
  const signed = ticket.status === 'signed';
  return (
    <div className="job-ticket__sign-popup" role="dialog" aria-modal="true" aria-label="Customer signature">
      <div className="job-ticket__sign-popup-card">
        <p className="job-ticket__sign-popup-title">Sign with your finger</p>
        <p className="job-ticket__sign-popup-hint">
          Sign and initial below. Each stroke saves onto the work order when you lift your finger.
        </p>
        <label>
          Printed name
          <input
            value={ticket.customerSignedName || ticket.customerName}
            onChange={(event) => onChange('customerSignedName', event.target.value)}
            autoComplete="name"
            autoCapitalize="words"
          />
        </label>
        <label className="job-ticket__sign-pad">
          Signature
          <SignaturePad
            value={ticket.customerSignature}
            onChange={(value) => onChange('customerSignature', value)}
            finger
            className="job-ticket__pad-finger"
          />
        </label>
        <label className="job-ticket__sign-pad job-ticket__sign-pad--initial">
          Initial
          <SignaturePad
            value={ticket.customerInitial}
            onChange={(value) => onChange('customerInitial', value)}
            finger
            className="job-ticket__pad-finger-sm"
          />
        </label>
        {status ? <p className="job-ticket__ok">{status}</p> : null}
        {signed ? (
          <p className="job-ticket__ok">
            Saved on the work order
            {ticket.signedAt ? ` · ${formatSignedAt(ticket.signedAt)}` : ''}.
          </p>
        ) : null}
        <div className="job-ticket__sign-popup-actions">
          <button type="button" onClick={onClose}>
            {signed || ticket.customerSignature ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

function setTicketQuery(id: string, sign: boolean) {
  history.replaceState(null, '', workOrderHref({ ticket: id, sign }));
}

export default function JobTicketEditor({
  serviceDate,
  initialTicket,
  sourceStop,
  updateUrl = true,
  customerSign,
  onCustomerSignChange,
  hideNew = false,
  initialSignOpen = false,
  embedded = false,
  onDeleted,
}: {
  serviceDate: string;
  initialTicket: Omit<JobTicket, 'id'> & { id?: string };
  sourceStop?: TicketStopSource;
  updateUrl?: boolean;
  customerSign: boolean;
  onCustomerSignChange: (sign: boolean) => void;
  hideNew?: boolean;
  initialSignOpen?: boolean;
  embedded?: boolean;
  onDeleted?: () => void;
}) {
  const [ticketId, setTicketId] = useState(initialTicket.id || '');
  const [ticket, setTicket] = useState(initialTicket);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [signOpen, setSignOpen] = useState(Boolean(initialSignOpen));
  const [pendingDelete, setPendingDelete] = useState<JobTicket | null>(null);
  const [auditEvents, setAuditEvents] = useState<JobTicketAuditEvent[]>([]);
  const lastPersistedRef = useRef<Record<string, string> | null>(
    initialTicket.id && (initialTicket.customerName || initialTicket.workOrderNumber)
      ? ticketAuditSnapshot(initialTicket as JobTicket)
      : null
  );
  const heaterRefineSeq = useRef(0);
  const signatureSaveSeq = useRef(0);
  const ticketIdRef = useRef(initialTicket.id || '');
  const persistGate = useRef(Promise.resolve());
  const lastLocalSign = useRef<{
    signature: string;
    initial: string;
    name: string;
    status: JobTicket['status'];
    signedAt?: string;
    accepted: boolean;
    seq: number;
  } | null>(null);
  const signable = ticket.status !== 'signed';
  ticketIdRef.current = ticketId;

  useEffect(() => {
    if (!ticketId) return;
    return subscribeJobTicket(
      ticketId,
      (next) => {
        if (!next) {
          setTicket((current) => {
            if (current.id !== ticketId) return current;
            return emptyJobTicket(serviceDate);
          });
          setTicketId((current) => (current === ticketId ? '' : current));
          return;
        }
        setTicket((current) => {
          const local = lastLocalSign.current;
          if (local && local.seq === signatureSaveSeq.current) {
            return {
              ...next,
              customerSignature: local.signature,
              customerInitial: local.initial,
              customerSignedName: local.name || next.customerSignedName,
              status: local.status,
              signedAt: local.signedAt,
              authorizationAccepted: local.accepted,
            };
          }
          if (
            (current.customerSignature && !next.customerSignature) ||
            (current.customerInitial && !next.customerInitial)
          ) {
            return current;
          }
          if (!lastPersistedRef.current) {
            lastPersistedRef.current = ticketAuditSnapshot(next);
          }
          return next;
        });
      },
      (err) => setError(err.message)
    );
  }, [ticketId, serviceDate]);

  useEffect(() => {
    if (!ticketId) {
      setAuditEvents([]);
      return;
    }
    return subscribeJobTicketAudit(ticketId, setAuditEvents, (err) => setError(err.message));
  }, [ticketId]);

  useEffect(() => {
    setTicket((current) => {
      if (current.id || current.serviceDate === serviceDate) return current;
      return { ...current, serviceDate };
    });
  }, [serviceDate]);

  useEffect(() => {
    if (!initialTicket.id || ticketIdRef.current) return;
    ticketIdRef.current = initialTicket.id;
    setTicketId(initialTicket.id);
    setTicket(initialTicket);
    lastPersistedRef.current = ticketAuditSnapshot(initialTicket as JobTicket);
  }, [initialTicket.id]);

  useEffect(() => {
    if (!sourceStop || ticket.id) return;
    const raw = rawInstallText(sourceStop);
    const seq = ++heaterRefineSeq.current;
    if (!heaterTypeNeedsAi(raw)) return;
    void summarizeHeaterType(raw)
      .then((result) => {
        if (seq !== heaterRefineSeq.current || !result.heaterType) return;
        setTicket((current) => {
          if (current.id || current.workOrderNumber !== (sourceStop.workOrderNumber || '')) {
            return current;
          }
          return {
            ...current,
            heaterModel: result.model || current.heaterModel,
            materials: current.materials.map((row, index) =>
              index === 0 ? { ...row, description: result.heaterType } : row
            ),
          };
        });
      })
      .catch(() => undefined);
  }, [sourceStop, ticket.id]);

  useEffect(() => {
    if (!signOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [signOpen]);

  const suggestion = useMemo(() => suggestedTotal(ticket), [ticket]);
  const fontSize = clampWoFontSize(ticket.pdfFontSize);

  const bumpFontSize = (delta: number) => {
    setTicket((current) => ({
      ...current,
      pdfFontSize: clampWoFontSize(clampWoFontSize(current.pdfFontSize) + delta),
    }));
  };

  const recordAudit = async (saved: JobTicket) => {
    try {
      const after = ticketAuditSnapshot(saved);
      const before = lastPersistedRef.current;
      const changes = ticketAuditDiff(before, after);
      const action = !before
        ? 'created'
        : after.status === 'signed' && before.status !== 'signed'
          ? 'signed'
          : before.status === 'signed'
            ? 'amended'
            : 'saved';
      if (action !== 'created' && action !== 'signed' && !Object.keys(changes).length) {
        lastPersistedRef.current = after;
        return;
      }
      await appendJobTicketAudit(saved.id, action, changes);
      lastPersistedRef.current = after;
    } catch (err) {
      console.warn('Could not write ticket audit', err);
    }
  };

  const persist = (next = ticket, options: { silent?: boolean } = {}) => {
    const seq = signatureSaveSeq.current;
    if (!options.silent) {
      setSaving(true);
      setError('');
    }
    const run = persistGate.current.then(async () => {
      if (seq !== signatureSaveSeq.current) return null;
      const id = next.id || ticketIdRef.current;
      const payload = { ...next, id };
      if (!id) {
        const createdId = await createJobTicket(next);
        const created = { ...next, id: createdId };
        ticketIdRef.current = createdId;
        setTicketId(createdId);
        setTicket(created);
        if (updateUrl) setTicketQuery(createdId, customerSign);
        if (!options.silent) setStatus('Ticket saved.');
        else setStatus('Saved on work order.');
        await recordAudit(created);
        return created;
      }
      if (seq !== signatureSaveSeq.current) return null;
      await saveJobTicket(payload as JobTicket);
      if (seq !== signatureSaveSeq.current) return payload as JobTicket;
      setTicket(payload);
      if (!options.silent) setStatus('Ticket saved.');
      else setStatus('Saved on work order.');
      await recordAudit(payload as JobTicket);
      return payload as JobTicket;
    });
    persistGate.current = run.then(
      () => undefined,
      () => undefined
    );
    return run
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      })
      .finally(() => {
        if (!options.silent && seq === signatureSaveSeq.current) setSaving(false);
      });
  };

  const update = <K extends keyof JobTicket>(key: K, value: JobTicket[K]) => {
    setTicket((current) => {
      const next = { ...current, [key]: value };
      if (key === 'street' || key === 'city' || key === 'zip') {
        next.address = combinedAddress(
          key === 'street' ? String(value) : current.street,
          key === 'city' ? String(value) : current.city,
          key === 'zip' ? String(value) : current.zip
        );
      }
      if (key === 'customerSignature' || key === 'customerInitial' || key === 'customerSignedName') {
        const signed = withAutoSignature(next);
        const seq = ++signatureSaveSeq.current;
        lastLocalSign.current = {
          signature: signed.customerSignature,
          initial: signed.customerInitial,
          name: signed.customerSignedName,
          status: signed.status,
          signedAt: signed.signedAt,
          accepted: signed.authorizationAccepted,
          seq,
        };
        window.setTimeout(() => {
          if (seq !== signatureSaveSeq.current) return;
          void persist(signed, { silent: true });
        }, 280);
        return signed;
      }
      return next;
    });
  };

  const updateMaterial = (index: number, field: keyof JobTicketMaterial, value: string) => {
    setTicket((current) => ({
      ...current,
      materials: current.materials.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row
      ),
    }));
  };

  const updateExtra = (index: number, field: keyof JobTicketMaterial, value: string) => {
    setTicket((current) => ({
      ...current,
      extraCharges: (
        current.extraCharges?.length ? current.extraCharges : emptyJobTicket(current.serviceDate).extraCharges
      ).map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)),
    }));
  };

  const updateExtraNotes = (value: string) => {
    setTicket((current) => {
      const extras = (
        current.extraCharges?.length
          ? current.extraCharges
          : emptyJobTicket(current.serviceDate).extraCharges
      ).map((row) => ({ ...row }));
      const lines = value.split('\n');
      const last = extras.length - 1;
      return {
        ...current,
        extraCharges: extras.map((row, index) => ({
          ...row,
          description: index === last ? lines.slice(last).join('\n') : lines[index] || '',
        })),
      };
    });
  };

  const handToCustomer = async () => {
    const saved = await persist({
      ...ticket,
      totalAmount: ticket.totalAmount || suggestion,
      customerSignedName: ticket.customerSignedName || ticket.customerName,
    });
    if (!saved?.id) return;
    if (updateUrl) setTicketQuery(saved.id, true);
    onCustomerSignChange(true);
    setSignOpen(true);
  };

  const closeSignPopup = () => {
    setSignOpen(false);
    if (ticket.status === 'signed') {
      if (updateUrl) setTicketQuery(ticket.id || ticketId, false);
      onCustomerSignChange(false);
    }
  };

  const downloadPdf = async () => {
    setDownloading(true);
    setError('');
    try {
      await downloadJobTicketPdf(
        {
          ...ticket,
          totalAmount: ticket.totalAmount || suggestion,
        },
        suggestion
      );
      setStatus('PDF downloaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const printPdf = async () => {
    setDownloading(true);
    setError('');
    try {
      await printJobTicketPdf(
        {
          ...ticket,
          totalAmount: ticket.totalAmount || suggestion,
        },
        suggestion
      );
      setStatus('Opened print preview.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const resetOpenTicket = () => {
    lastLocalSign.current = null;
    lastPersistedRef.current = null;
    signatureSaveSeq.current += 1;
    setTicket(emptyJobTicket(serviceDate));
    setTicketId('');
    if (updateUrl) history.replaceState(null, '', workOrderHref());
  };

  const confirmDeleteTicket = async () => {
    if (!pendingDelete) return;
    setSaving(true);
    setError('');
    try {
      await appendJobTicketAudit(pendingDelete.id, 'deleted', {}).catch(() => undefined);
      await deleteJobTicket(pendingDelete.id);
      setPendingDelete(null);
      setStatus('Ticket deleted.');
      resetOpenTicket();
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const form = (
    <HeatersWorkOrderForm
      ticket={ticket}
      suggestedTotal={suggestion}
      readOnly={customerSign}
      customerSign={customerSign}
      signable={signable}
      onChange={update}
      onMaterialChange={updateMaterial}
      onExtraChange={updateExtra}
      onExtraNotesChange={updateExtraNotes}
      onRequestSign={() => setSignOpen(true)}
    />
  );

  const confirmPopup = pendingDelete ? (
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
  ) : null;

  const popup = signOpen ? (
    <SignPopup ticket={ticket} status={status} onChange={update} onClose={closeSignPopup} />
  ) : null;

  if (customerSign) {
    return (
      <div className={`job-ticket job-ticket--sign${embedded ? ' job-ticket--sign-embedded' : ''}`}>
        <div className="job-ticket__sign-scroll">{form}</div>
        <div className="job-ticket__sign-bar">
          {error && <p className="job-ticket__error">{error}</p>}
          {status && !signOpen ? <p className="job-ticket__ok">{status}</p> : null}
          <div className="job-ticket__sign-actions">
            {ticket.status !== 'signed' ? (
              <button type="button" onClick={() => setSignOpen(true)}>
                Sign with finger
              </button>
            ) : (
              <p className="job-ticket__ok">
                Signed by <strong>{ticket.customerSignedName || ticket.customerName}</strong>
                {ticket.signedAt ? ` · ${formatSignedAt(ticket.signedAt)}` : ''}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setSignOpen(false);
                if (updateUrl) setTicketQuery(ticket.id || ticketId, false);
                onCustomerSignChange(false);
              }}
            >
              Back to plumber form
            </button>
          </div>
        </div>
        {popup}
      </div>
    );
  }

  return (
    <div className="job-ticket__sheet">
      <div className="job-ticket__toolbar">
        <div className="job-ticket__templates" role="radiogroup" aria-label="Work order form">
          <button
            type="button"
            role="radio"
            aria-checked={ticket.formTemplate === 'heaters'}
            className={ticket.formTemplate === 'heaters' ? 'is-active' : ''}
            onClick={() => update('formTemplate', 'heaters')}
          >
            1-800 Heaters
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={ticket.formTemplate !== 'heaters'}
            className={ticket.formTemplate !== 'heaters' ? 'is-active' : ''}
            onClick={() => update('formTemplate', 'nj')}
          >
            N&J Plumbing
          </button>
        </div>
        <div className="job-ticket__font-size" role="group" aria-label="Work order font size">
          <span>Font size</span>
          <button
            type="button"
            aria-label="Smaller font"
            disabled={fontSize <= MIN_WO_FONT_SIZE}
            onClick={() => bumpFontSize(-1)}
          >
            A−
          </button>
          <span className="job-ticket__font-size-value">{fontSize}</span>
          <button
            type="button"
            aria-label="Larger font"
            disabled={fontSize >= MAX_WO_FONT_SIZE}
            onClick={() => bumpFontSize(1)}
          >
            A+
          </button>
        </div>
      </div>
      {form}
      {ticket.status === 'signed' && (
        <p className="job-ticket__ok">
          Signed by <strong>{ticket.customerSignedName}</strong>
          {ticket.signedAt ? ` · ${formatSignedAt(ticket.signedAt)}` : ''}.
          You can still edit fields such as the model number. Those changes are logged.
        </p>
      )}
      {ticket.id && auditEvents.length > 0 ? (
        <section className="job-ticket__audit">
          <h3>Work order log</h3>
          <ul>
            {auditEvents.map((event) => (
              <li key={event.id}>
                <strong>{auditActionLabel(event.action)}</strong>
                <span>{formatSignedAt(event.at || event.clientAt)}</span>
                {Object.keys(event.changes).length > 0 ? (
                  <span>
                    {Object.entries(event.changes)
                      .slice(0, 6)
                      .map(([field, change]) => `${field}: ${change.to || '(empty)'}`)
                      .join(' · ')}
                  </span>
                ) : null}
                <code title="SHA-256 integrity hash">{event.hash.slice(0, 12)}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {error && <p className="job-ticket__error">{error}</p>}
      {status && !signOpen ? <p className="job-ticket__ok">{status}</p> : null}
      <div className="job-ticket__actions">
        <button type="button" onClick={() => void persist()} disabled={saving}>
          {saving ? 'Saving…' : 'Save ticket'}
        </button>
        <button type="button" onClick={() => void handToCustomer()} disabled={saving}>
          Customer sign
        </button>
        {hideNew ? null : (
          <button type="button" onClick={resetOpenTicket}>
            New ticket
          </button>
        )}
        {ticket.id ? (
          <button
            type="button"
            className="job-ticket__delete-open"
            onClick={() => setPendingDelete(ticket as JobTicket)}
          >
            Delete ticket
          </button>
        ) : null}
        <button type="button" onClick={() => void printPdf()} disabled={saving || downloading}>
          {downloading ? 'Opening…' : 'Print'}
        </button>
        <button type="button" onClick={() => void downloadPdf()} disabled={saving || downloading}>
          {downloading ? 'Downloading…' : 'Download PDF'}
        </button>
      </div>
      {popup}
      {confirmPopup}
    </div>
  );
}
