import { useMemo, useState, useEffect } from 'react';
import type { DispatchPlan, JobTicket, StoredWorkOrder } from '../types';
import { subscribeDispatchPlan } from '../services/dispatchService';
import {
  findJobTicketForStop,
  jobTicketIsSigned,
  subscribeJobTicketsForWorkOrders,
} from '../services/jobTicketService';
import {
  setWorkOrderOfficeChecks,
  subscribeWorkOrdersForDate,
} from '../services/workOrderService';
import { notesDuplicateAnotherWorkOrder } from '../utils/duplicateWorkOrder';
import { formatWindowLabel } from '../utils/dispatchWindows';
import { retailerPortalLabel } from '../utils/heaterInstallDescription';
import { workOrderHref } from '../utils/workOrderPage';
import DispatchDayStrip, { formatDispatchDay } from './DispatchDayStrip';
import './DayWork.css';

type Lane = 'truck' | 'ready' | 'not-ready' | 'closed';

type DayWorkRow = {
  id: string;
  workOrderNumber: string;
  customerName: string;
  address: string;
  jobType: string;
  installDescription: string;
  lane: Lane;
  truckName: string;
  windowLabel: string;
  cancelled: boolean;
  paperworkDone: boolean;
  permitPulled: boolean;
  retailerUploaded: boolean;
  retailerLabel: string;
  ticketId?: string;
};

interface DayWorkProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

function isDuplicateJob(job: StoredWorkOrder): boolean {
  if (job.manualSchedule) return false;
  if ((job.duplicateOfWorkOrderNumber || '').trim()) return true;
  return notesDuplicateAnotherWorkOrder(job.notes || '', job.workOrderNumber || '');
}

function findStopAssignment(
  plan: DispatchPlan | null,
  workOrderId: string
): { lane: Lane; truckName: string; windowLabel: string; cancelled: boolean } | null {
  if (!plan) return null;
  const trucks: Array<{ name: string; windowLabel: string; cancelled: boolean }> = [];
  for (const truck of plan.trucks) {
    const stop = truck.stops.find(
      (item) => item.workOrderId === workOrderId || item.id === workOrderId
    );
    if (stop) {
      trucks.push({
        name: truck.name,
        windowLabel: formatWindowLabel(stop.window),
        cancelled: stop.cancelled === true,
      });
    }
  }
  if (trucks.length) {
    return {
      lane: 'truck',
      truckName: trucks.map((item) => item.name).join(' + '),
      windowLabel: trucks[0].windowLabel,
      cancelled: trucks.every((item) => item.cancelled),
    };
  }
  const unassigned = plan.unassigned.find(
    (item) => item.workOrderId === workOrderId || item.id === workOrderId
  );
  if (unassigned) {
    return {
      lane: 'ready',
      truckName: 'Ready',
      windowLabel: formatWindowLabel(unassigned.window),
      cancelled: unassigned.cancelled === true,
    };
  }
  const notReady = plan.notReady.find(
    (item) => item.workOrderId === workOrderId || item.id === workOrderId
  );
  if (notReady) {
    return {
      lane: 'not-ready',
      truckName: 'Not ready',
      windowLabel: formatWindowLabel(notReady.window),
      cancelled: false,
    };
  }
  return null;
}

function toRow(
  job: StoredWorkOrder,
  plan: DispatchPlan | null,
  tickets: JobTicket[]
): DayWorkRow {
  const assignment = findStopAssignment(plan, job.id);
  const ticket = findJobTicketForStop(tickets, {
    id: job.id,
    workOrderId: job.id,
    workOrderNumber: job.workOrderNumber,
  });
  return {
    id: job.id,
    workOrderNumber: job.workOrderNumber,
    customerName: job.customerName || 'Customer',
    address: job.address,
    jobType: job.jobType,
    installDescription: job.installDescription || '',
    lane: assignment?.lane || (job.status === 'closed' ? 'closed' : 'ready'),
    truckName:
      assignment?.truckName || (job.status === 'closed' ? 'Closed' : 'On schedule'),
    windowLabel: assignment?.windowLabel || job.appointmentTime || '',
    cancelled: assignment?.cancelled === true,
    paperworkDone: ticket ? jobTicketIsSigned(ticket) : false,
    permitPulled: job.permitPulled === true,
    retailerUploaded: job.retailerUploaded === true,
    retailerLabel: retailerPortalLabel(job.installDescription || ''),
    ticketId: ticket?.id,
  };
}

function laneOrder(lane: Lane): number {
  if (lane === 'truck') return 0;
  if (lane === 'ready') return 1;
  if (lane === 'not-ready') return 2;
  return 3;
}

export default function DayWork({ selectedDate, onSelectDate }: DayWorkProps) {
  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [workOrders, setWorkOrders] = useState<StoredWorkOrder[]>([]);
  const [tickets, setTickets] = useState<JobTicket[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [hideDone, setHideDone] = useState(false);

  useEffect(() => {
    return subscribeWorkOrdersForDate(
      selectedDate,
      setWorkOrders,
      (err) => setError(err.message)
    );
  }, [selectedDate]);

  useEffect(() => {
    return subscribeDispatchPlan(
      selectedDate,
      setPlan,
      (err) => setError(err.message)
    );
  }, [selectedDate]);

  useEffect(() => {
    const numbers = workOrders.map((job) => job.workOrderNumber).filter(Boolean);
    const ids = workOrders.map((job) => job.id).filter(Boolean);
    return subscribeJobTicketsForWorkOrders(numbers, ids, setTickets, (err) =>
      setError(err.message)
    );
  }, [workOrders]);

  const rows = useMemo(() => {
    const next = workOrders
      .filter((job) => !isDuplicateJob(job))
      .map((job) => toRow(job, plan, tickets));
    next.sort((a, b) => {
      const laneDelta = laneOrder(a.lane) - laneOrder(b.lane);
      if (laneDelta) return laneDelta;
      const truckDelta = a.truckName.localeCompare(b.truckName);
      if (truckDelta) return truckDelta;
      const windowDelta = a.windowLabel.localeCompare(b.windowLabel);
      if (windowDelta) return windowDelta;
      return a.customerName.localeCompare(b.customerName);
    });
    return next;
  }, [workOrders, plan, tickets]);

  const visibleRows = hideDone
    ? rows.filter((row) => !(row.paperworkDone && row.permitPulled && row.retailerUploaded))
    : rows;

  const totals = useMemo(() => {
    const paperwork = rows.filter((row) => row.paperworkDone).length;
    const permits = rows.filter((row) => row.permitPulled).length;
    const retailer = rows.filter((row) => row.retailerUploaded).length;
    const done = rows.filter(
      (row) => row.paperworkDone && row.permitPulled && row.retailerUploaded
    ).length;
    return { paperwork, permits, retailer, done, total: rows.length };
  }, [rows]);

  const toggleCheck = async (
    row: DayWorkRow,
    field: 'permitPulled' | 'retailerUploaded',
    done: boolean
  ) => {
    const key = `${row.id}:${field}`;
    const previous = workOrders.find((job) => job.id === row.id);
    setPending((current) => ({ ...current, [key]: true }));
    setError('');
    setWorkOrders((current) =>
      current.map((job) =>
        job.id === row.id
          ? {
              ...job,
              [field]: done,
              ...(field === 'permitPulled'
                ? { permitPulledAt: done ? new Date().toISOString() : undefined }
                : { retailerUploadedAt: done ? new Date().toISOString() : undefined }),
            }
          : job
      )
    );
    try {
      await setWorkOrderOfficeChecks(row.id, field, done);
    } catch (err) {
      if (previous) {
        setWorkOrders((current) =>
          current.map((job) => (job.id === row.id ? previous : job))
        );
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  return (
    <div className="day-work">
      <DispatchDayStrip
        selectedDate={selectedDate}
        onSelectDate={onSelectDate}
        label="Day work overview"
      />
      <div className="day-work__toolbar">
        <div>
          <h2>Day work · {formatDispatchDay(selectedDate)}</h2>
          <p>
            Jobs on today&apos;s schedule. Paperwork checks off when the customer
            signs. Mark the permit and Home Depot / Lowe&apos;s upload by hand.
          </p>
        </div>
        <label className="day-work__hide">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(event) => setHideDone(event.target.checked)}
          />
          Hide finished jobs
        </label>
      </div>
      <div className="day-work__summary" aria-live="polite">
        <span>
          <strong>{totals.done}</strong> of {totals.total} finished
        </span>
        <span>
          <strong>{totals.paperwork}</strong> paperwork
        </span>
        <span>
          <strong>{totals.permits}</strong> permits
        </span>
        <span>
          <strong>{totals.retailer}</strong> HD / Lowe&apos;s
        </span>
      </div>
      {error ? <p className="day-work__error">{error}</p> : null}
      {visibleRows.length === 0 ? (
        <p className="day-work__muted">
          {rows.length === 0
            ? 'No jobs on the schedule for this date.'
            : 'Every job on this date is finished.'}
        </p>
      ) : (
        <ul className="day-work__list">
          {visibleRows.map((row) => {
            const finished = row.paperworkDone && row.permitPulled && row.retailerUploaded;
            const permitKey = `${row.id}:permitPulled`;
            const retailerKey = `${row.id}:retailerUploaded`;
            return (
              <li
                key={row.id}
                className={`day-work__row${finished ? ' day-work__row--done' : ''}${
                  row.cancelled ? ' day-work__row--cancelled' : ''
                }`}
              >
                <div className="day-work__job">
                  <strong>{row.customerName}</strong>
                  <small>
                    {row.workOrderNumber ? `WO ${row.workOrderNumber}` : 'No WO #'}
                    {row.jobType ? ` · ${row.jobType}` : ''}
                  </small>
                  {row.address ? <small>{row.address}</small> : null}
                  <span className={`day-work__lane day-work__lane--${row.lane}`}>
                    {row.truckName}
                    {row.windowLabel ? ` · ${row.windowLabel}` : ''}
                    {row.cancelled ? ' · Cancelled' : ''}
                  </span>
                </div>
                <div className="day-work__checks">
                  <label
                    className={`day-work__check${
                      row.paperworkDone ? ' day-work__check--on' : ''
                    } day-work__check--locked`}
                    title={
                      row.paperworkDone
                        ? 'Customer signature is on the job ticket'
                        : 'Checks off when the customer signs the job ticket'
                    }
                  >
                    <input type="checkbox" checked={row.paperworkDone} disabled readOnly />
                    Paperwork
                  </label>
                  <label
                    className={`day-work__check${row.permitPulled ? ' day-work__check--on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={row.permitPulled}
                      disabled={Boolean(pending[permitKey])}
                      onChange={(event) =>
                        void toggleCheck(row, 'permitPulled', event.target.checked)
                      }
                    />
                    Permit pulled
                  </label>
                  <label
                    className={`day-work__check${
                      row.retailerUploaded ? ' day-work__check--on' : ''
                    }`}
                    title={`Mark when this job is uploaded to ${row.retailerLabel}`}
                  >
                    <input
                      type="checkbox"
                      checked={row.retailerUploaded}
                      disabled={Boolean(pending[retailerKey])}
                      onChange={(event) =>
                        void toggleCheck(row, 'retailerUploaded', event.target.checked)
                      }
                    />
                    {row.retailerLabel}
                  </label>
                </div>
                <a className="day-work__ticket" href={workOrderHref({ ticket: row.ticketId })}>
                  {row.paperworkDone ? 'Ticket' : 'Get signature'}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
