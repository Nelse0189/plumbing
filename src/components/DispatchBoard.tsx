import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { DispatchPlan, DispatchStop, DispatchTruck } from '../types';
import {
  autoOrderAllUnsetTrucks,
  autoOrderTruckStops,
  cancelMorningTextsForTruck,
  getDispatchPlan,
  queueMorningTextsForTruck,
  saveDispatchPlan,
} from '../services/dispatchService';
import {
  applyDefaultWindows,
  DEFAULT_DISPATCH_ORIGIN,
  formatWindowLabel,
} from '../utils/dispatchWindows';
import { initiateVoiceWindowConfirmation } from '../services/voiceConfirmationService';
import './DispatchBoard.css';

interface DispatchBoardProps {
  selectedDate: string;
}

type DragPayload =
  | { from: 'unassigned'; stopId: string }
  | { from: 'notReady'; stopId: string }
  | { from: 'truck'; truckId: string; stopId: string; index: number };

function parseDrag(data: string): DragPayload | null {
  try {
    return JSON.parse(data) as DragPayload;
  } catch {
    return null;
  }
}

function StopNode({
  stop,
  locked,
  onPriorityChange,
  onWindowChange,
  onCallConfirmation,
  calling,
  dragPayload,
}: {
  stop: DispatchStop;
  locked: boolean;
  onPriorityChange?: (priority: number) => void;
  onWindowChange?: (start: string, end: string) => void;
  onCallConfirmation?: () => void;
  calling?: boolean;
  dragPayload: DragPayload;
}) {
  return (
    <article
      className={`dispatch-node ${locked ? 'dispatch-node--locked' : ''}`}
      draggable={!locked}
      onDragStart={(event) => {
        event.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <header className="dispatch-node__header">
        <strong>{stop.workOrderNumber || 'No WO#'}</strong>
        {stop.distanceMiles != null && (
          <span className="dispatch-node__miles">{stop.distanceMiles} mi</span>
        )}
      </header>
      <p className="dispatch-node__customer">{stop.customerName}</p>
      <p className="dispatch-node__address">{stop.address || 'No address'}</p>
      <p className="dispatch-node__meta">{stop.jobType || 'Job type TBD'}</p>
      {stop.notes ? (
        <p className="dispatch-node__notes">{stop.notes}</p>
      ) : (
        <p className="dispatch-node__notes dispatch-node__notes--empty">No notes — not ready</p>
      )}
      <div className="dispatch-node__controls">
        <label>
          Priority
          <input
            type="number"
            min={0}
            max={99}
            disabled={locked || !onPriorityChange}
            value={stop.priority}
            onChange={(event) => onPriorityChange?.(Number(event.target.value) || 0)}
          />
        </label>
        {onWindowChange && (
          <label className="dispatch-node__window">
            Window
            <span>
              <input
                type="time"
                disabled={locked}
                value={stop.window.start}
                onChange={(event) => onWindowChange(event.target.value, stop.window.end)}
              />
              <span aria-hidden="true">–</span>
              <input
                type="time"
                disabled={locked}
                value={stop.window.end}
                onChange={(event) => onWindowChange(stop.window.start, event.target.value)}
              />
            </span>
            <small>{formatWindowLabel(stop.window)}{stop.customWindow ? ' (edited)' : ''}</small>
          </label>
        )}
        {onCallConfirmation && (
          <div className="dispatch-node__voice">
            <button
              type="button"
              disabled={calling}
              onClick={(event) => {
                event.stopPropagation();
                onCallConfirmation();
              }}
            >
              {calling ? 'Calling test…' : 'Call test confirmation'}
            </button>
            {stop.voiceCallStatus && (
              <small>
                Call: {stop.voiceCallStatus}
                {stop.voiceConfirmationResponse &&
                stop.voiceConfirmationResponse !== 'unknown'
                  ? ` · ${stop.voiceConfirmationResponse}`
                  : ''}
              </small>
            )}
            {stop.voiceConfirmationDetails && (
              <small>{stop.voiceConfirmationDetails}</small>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function DispatchBoard({ selectedDate }: DispatchBoardProps) {
  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [callingStopId, setCallingStopId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const loaded = await getDispatchPlan(selectedDate);
        if (!cancelled) setPlan(loaded);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  const assignedCount = useMemo(() => {
    if (!plan) return 0;
    return plan.trucks.reduce((sum, truck) => sum + truck.stops.length, 0);
  }, [plan]);

  const persist = async (next: DispatchPlan, message?: string) => {
    setSaving(true);
    setError(null);
    try {
      await saveDispatchPlan(next);
      setPlan(next);
      if (message) setStatus(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeStop = (
    current: DispatchPlan,
    payload: DragPayload
  ): { plan: DispatchPlan; stop: DispatchStop | null } => {
    if (payload.from === 'unassigned') {
      const stop = current.unassigned.find((item) => item.id === payload.stopId) || null;
      return {
        stop,
        plan: {
          ...current,
          unassigned: current.unassigned.filter((item) => item.id !== payload.stopId),
        },
      };
    }
    if (payload.from === 'notReady') {
      const stop = current.notReady.find((item) => item.id === payload.stopId) || null;
      return {
        stop,
        plan: {
          ...current,
          notReady: current.notReady.filter((item) => item.id !== payload.stopId),
        },
      };
    }
    const truck = current.trucks.find((item) => item.id === payload.truckId);
    const stop = truck?.stops.find((item) => item.id === payload.stopId) || null;
    return {
      stop,
      plan: {
        ...current,
        trucks: current.trucks.map((item) => {
          if (item.id !== payload.truckId) return item;
          return {
            ...item,
            stops: applyDefaultWindows(item.stops.filter((s) => s.id !== payload.stopId)),
          };
        }),
      },
    };
  };

  const onDropToLane = async (
    event: DragEvent,
    target:
      | { type: 'unassigned' }
      | { type: 'notReady' }
      | { type: 'truck'; truckId: string; index?: number }
  ) => {
    event.preventDefault();
    if (!plan) return;
    const payload = parseDrag(event.dataTransfer.getData('application/json'));
    if (!payload) return;

    if (target.type === 'truck') {
      const truck = plan.trucks.find((item) => item.id === target.truckId);
      if (!truck || truck.set) {
        setError('That truck is Set. Reopen it before changing stops.');
        return;
      }
    }

    const { plan: without, stop } = removeStop(plan, payload);
    if (!stop) return;

    let next: DispatchPlan = without;
    if (target.type === 'unassigned') {
      next = { ...without, unassigned: [...without.unassigned, stop] };
    } else if (target.type === 'notReady') {
      next = { ...without, notReady: [...without.notReady, stop] };
    } else if (target.type === 'truck') {
      const truckId = target.truckId;
      const insertIndex = target.index;
      next = {
        ...without,
        trucks: without.trucks.map((truck) => {
          if (truck.id !== truckId) return truck;
          const stops = [...truck.stops];
          const insertAt =
            insertIndex == null || insertIndex < 0 || insertIndex > stops.length
              ? stops.length
              : insertIndex;
          stops.splice(insertAt, 0, { ...stop, customWindow: stop.customWindow });
          return { ...truck, stops: applyDefaultWindows(stops) };
        }),
      };
    }

    await persist(next);
  };

  const updateStopOnTruck = async (
    truckId: string,
    stopId: string,
    updater: (stop: DispatchStop) => DispatchStop
  ) => {
    if (!plan) return;
    const truck = plan.trucks.find((item) => item.id === truckId);
    if (!truck || truck.set) return;
    const next: DispatchPlan = {
      ...plan,
      trucks: plan.trucks.map((item) => {
        if (item.id !== truckId) return item;
        return {
          ...item,
          stops: item.stops.map((stop) => (stop.id === stopId ? updater(stop) : stop)),
        };
      }),
    };
    await persist(next);
  };

  const handleSetTruck = async (truck: DispatchTruck, set: boolean) => {
    if (!plan) return;
    setSaving(true);
    setError(null);
    try {
      let updatedTruck: DispatchTruck;
      if (set) {
        if (truck.stops.length === 0) {
          setError('Add at least one stop before marking a truck Set.');
          return;
        }
        updatedTruck = await queueMorningTextsForTruck(plan, truck);
      } else {
        updatedTruck = await cancelMorningTextsForTruck(plan, truck);
      }
      const next: DispatchPlan = {
        ...plan,
        trucks: plan.trucks.map((item) => (item.id === truck.id ? updatedTruck : item)),
      };
      await saveDispatchPlan(next);
      setPlan(next);
      setStatus(
        set
          ? `${truck.name} is Set. Morning window texts queued for the test number (+18609643025).`
          : `${truck.name} reopened. Pending morning texts cancelled.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleVoiceConfirmation = async (truck: DispatchTruck, stop: DispatchStop) => {
    if (!plan) return;
    setCallingStopId(stop.id);
    setError(null);
    try {
      const result = await initiateVoiceWindowConfirmation(
        plan.date,
        truck.id,
        stop.id
      );
      const next: DispatchPlan = {
        ...plan,
        trucks: plan.trucks.map((candidate) =>
          candidate.id !== truck.id
            ? candidate
            : {
                ...candidate,
                stops: candidate.stops.map((candidateStop) =>
                  candidateStop.id !== stop.id
                    ? candidateStop
                    : {
                        ...candidateStop,
                        voiceCallStatus: 'queued',
                        voiceConfirmationResponse: 'unknown',
                        voiceConfirmationDetails: 'Test call queued',
                      }
                ),
              }
        ),
      };
      setPlan(next);
      setStatus(
        `Test confirmation call queued to ${result.testRecipient} for ${formatWindowLabel(
          stop.window
        )}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCallingStopId(null);
    }
  };

  if (loading || !plan) {
    return <div className="dispatch-board__loading">Loading CT dispatch board…</div>;
  }

  return (
    <div className="dispatch-board">
      <div className="dispatch-board__toolbar">
        <div>
          <h2>CT Dispatch · 5 trucks</h2>
          <p>
            Depot: {plan.originAddress || DEFAULT_DISPATCH_ORIGIN}. Default windows: 1st 8–12,
            2nd 10–2, 3rd 12–4 (editable). Morning texts and temporary voice confirmations
            still go to the test number.
          </p>
        </div>
        <div className="dispatch-board__actions">
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                const ordered = await autoOrderAllUnsetTrucks(plan);
                await persist(ordered, 'Ordered unset trucks farthest-from-depot first (priority wins).');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
          >
            Auto-order by distance
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              const refreshed = await getDispatchPlan(selectedDate);
              setPlan(refreshed);
              setStatus('Reloaded jobs for this date.');
            }}
          >
            Refresh jobs
          </button>
          <span className="dispatch-board__counts">
            {assignedCount} assigned · {plan.unassigned.length} ready · {plan.notReady.length} not
            ready
          </span>
        </div>
      </div>

      {error && <div className="dispatch-board__error">{error}</div>}
      {status && <div className="dispatch-board__status">{status}</div>}

      <div className="dispatch-board__lanes">
        <section
          className="dispatch-lane dispatch-lane--not-ready"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => void onDropToLane(event, { type: 'notReady' })}
        >
          <h3>Not Ready</h3>
          <p className="dispatch-lane__hint">Missing notes on the work order PDF/doc</p>
          {plan.notReady.length === 0 && (
            <p className="dispatch-lane__empty">No blocked jobs</p>
          )}
          {plan.notReady.map((stop) => (
            <StopNode
              key={stop.id}
              stop={stop}
              locked={false}
              dragPayload={{ from: 'notReady', stopId: stop.id }}
            />
          ))}
        </section>

        <section
          className="dispatch-lane dispatch-lane--unassigned"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => void onDropToLane(event, { type: 'unassigned' })}
        >
          <h3>Ready / Unassigned</h3>
          <p className="dispatch-lane__hint">Drag onto a truck</p>
          {plan.unassigned.length === 0 && (
            <p className="dispatch-lane__empty">No unassigned ready jobs</p>
          )}
          {plan.unassigned.map((stop) => (
            <StopNode
              key={stop.id}
              stop={stop}
              locked={false}
              onPriorityChange={async (priority) => {
                const next = {
                  ...plan,
                  unassigned: plan.unassigned.map((item) =>
                    item.id === stop.id ? { ...item, priority } : item
                  ),
                };
                await persist(next);
              }}
              dragPayload={{ from: 'unassigned', stopId: stop.id }}
            />
          ))}
        </section>

        <div className="dispatch-board__trucks">
          {plan.trucks.map((truck) => (
            <section
              key={truck.id}
              className={`dispatch-truck ${truck.set ? 'dispatch-truck--set' : ''}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) =>
                void onDropToLane(event, { type: 'truck', truckId: truck.id })
              }
            >
              <header className="dispatch-truck__header">
                <div>
                  <h3>{truck.name}</h3>
                  <span>
                    {truck.stops.length} stop{truck.stops.length === 1 ? '' : 's'}
                    {truck.set ? ' · SET' : ''}
                  </span>
                </div>
                <div className="dispatch-truck__actions">
                  <button
                    type="button"
                    disabled={saving || truck.set || truck.stops.length < 2}
                    onClick={async () => {
                      const ordered = await autoOrderTruckStops(plan, truck.id);
                      await persist(ordered, `${truck.name} ordered farthest first.`);
                    }}
                  >
                    Farthest first
                  </button>
                  {truck.set ? (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleSetTruck(truck, false)}
                    >
                      Reopen
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="dispatch-truck__set"
                      disabled={saving || truck.stops.length === 0}
                      onClick={() => void handleSetTruck(truck, true)}
                    >
                      Set
                    </button>
                  )}
                </div>
              </header>

              {truck.stops.length === 0 && (
                <p className="dispatch-lane__empty">Drop jobs here</p>
              )}

              {truck.stops.map((stop, index) => (
                <div
                  key={stop.id}
                  className="dispatch-truck__slot"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.stopPropagation();
                    void onDropToLane(event, {
                      type: 'truck',
                      truckId: truck.id,
                      index,
                    });
                  }}
                >
                  <span className="dispatch-truck__order">{index + 1}</span>
                  <StopNode
                    stop={stop}
                    locked={truck.set}
                    dragPayload={{
                      from: 'truck',
                      truckId: truck.id,
                      stopId: stop.id,
                      index,
                    }}
                    onPriorityChange={(priority) =>
                      void updateStopOnTruck(truck.id, stop.id, (current) => ({
                        ...current,
                        priority,
                      }))
                    }
                    onWindowChange={(start, end) =>
                      void updateStopOnTruck(truck.id, stop.id, (current) => ({
                        ...current,
                        window: { start, end },
                        customWindow: true,
                      }))
                    }
                    onCallConfirmation={() =>
                      void handleVoiceConfirmation(truck, stop)
                    }
                    calling={callingStopId === stop.id}
                  />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
