import {
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import type { DispatchPlan, DispatchTruck, Plumber } from '../types';

export const PLUMBERS_DOC = doc(db, 'appConfig', 'plumbers');
const MAX_NAME_LENGTH = 80;

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function newPlumberId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizePlumberName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

export function mapPlumbers(value: unknown): Plumber[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const plumbers: Plumber[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = normalizePlumberName(asText(record.name));
    const id = asText(record.id) || newPlumberId();
    if (!name || seen.has(id)) continue;
    seen.add(id);
    const plumber: Plumber = { id, name };
    if ('truckId' in record) {
      plumber.truckId = asText(record.truckId);
    }
    plumbers.push(plumber);
  }
  return plumbers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function serializePlumber(plumber: Plumber): {
  id: string;
  name: string;
  truckId?: string;
} {
  const row: { id: string; name: string; truckId?: string } = {
    id: plumber.id,
    name: plumber.name,
  };
  if (plumber.truckId !== undefined) {
    row.truckId = plumber.truckId;
  }
  return row;
}

export function subscribePlumbers(
  onChange: (plumbers: Plumber[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    PLUMBERS_DOC,
    (snap) => {
      onChange(mapPlumbers(snap.data()?.people));
    },
    (error) => {
      onError?.(error);
    }
  );
}

export async function loadPlumbers(): Promise<Plumber[]> {
  const snap = await getDoc(PLUMBERS_DOC);
  return mapPlumbers(snap.data()?.people);
}

async function savePlumbers(plumbers: Plumber[]): Promise<Plumber[]> {
  const people = mapPlumbers(plumbers);
  await setDoc(
    PLUMBERS_DOC,
    {
      people: people.map(serializePlumber),
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
  return people;
}

export async function addPlumber(
  plumbers: Plumber[],
  name: string
): Promise<Plumber[]> {
  const normalized = normalizePlumberName(name);
  if (!normalized) {
    throw new Error('Enter a plumber name.');
  }
  const duplicate = plumbers.some(
    (plumber) => plumber.name.localeCompare(normalized, undefined, { sensitivity: 'base' }) === 0
  );
  if (duplicate) {
    throw new Error(`${normalized} is already on the plumber list.`);
  }
  return savePlumbers([...plumbers, { id: newPlumberId(), name: normalized }]);
}

export async function removePlumber(
  plumbers: Plumber[],
  plumberId: string
): Promise<Plumber[]> {
  return savePlumbers(plumbers.filter((plumber) => plumber.id !== plumberId));
}

export async function setPlumberTruck(
  plumbers: Plumber[],
  plumberId: string,
  truckId: string
): Promise<Plumber[]> {
  const exists = plumbers.some((plumber) => plumber.id === plumberId);
  if (!exists) {
    throw new Error('That plumber is not on the list.');
  }
  return savePlumbers(
    plumbers.map((plumber) =>
      plumber.id === plumberId ? { ...plumber, truckId } : plumber
    )
  );
}

export function plumberNamesForIds(
  plumberIds: string[] | undefined,
  plumbers: Plumber[]
): string[] {
  if (!plumberIds?.length) return [];
  const byId = new Map(plumbers.map((plumber) => [plumber.id, plumber.name]));
  return plumberIds
    .map((id) => byId.get(id))
    .filter((name): name is string => Boolean(name));
}

function withPlumberIds(
  truck: DispatchTruck,
  plumberIds: string[],
  plumbers: Plumber[]
): DispatchTruck {
  const names = plumberNamesForIds(plumberIds, plumbers);
  const next: DispatchTruck = {
    ...truck,
    plumberIds,
  };
  if (names.length > 0) {
    next.driver = names.join(', ');
  } else {
    delete next.driver;
  }
  return next;
}

export function applyPlumberAssignmentsToPlan(
  plan: DispatchPlan,
  plumbers: Plumber[]
): DispatchPlan {
  if (plumbers.length === 0) return plan;

  const byTruck = new Map<string, string[]>();
  for (const truck of plan.trucks) {
    byTruck.set(truck.id, []);
  }

  const placed = new Set<string>();
  for (const plumber of plumbers) {
    if (plumber.truckId === undefined) continue;
    placed.add(plumber.id);
    if (plumber.truckId && byTruck.has(plumber.truckId)) {
      byTruck.get(plumber.truckId)!.push(plumber.id);
    }
  }

  for (const truck of plan.trucks) {
    for (const plumberId of truck.plumberIds || []) {
      if (placed.has(plumberId)) continue;
      const plumber = plumbers.find((item) => item.id === plumberId);
      if (!plumber) continue;
      byTruck.get(truck.id)!.push(plumberId);
      placed.add(plumberId);
    }
  }

  return {
    ...plan,
    trucks: plan.trucks.map((truck) =>
      withPlumberIds(truck, byTruck.get(truck.id) || [], plumbers)
    ),
  };
}

export async function seedPlumberAssignmentsFromPlan(
  plumbers: Plumber[],
  plan: DispatchPlan
): Promise<Plumber[] | null> {
  const fromPlan = new Map<string, string>();
  for (const truck of plan.trucks) {
    for (const plumberId of truck.plumberIds || []) {
      fromPlan.set(plumberId, truck.id);
    }
  }
  if (fromPlan.size === 0) return null;

  let changed = false;
  const next = plumbers.map((plumber) => {
    if (plumber.truckId !== undefined) return plumber;
    const truckId = fromPlan.get(plumber.id);
    if (!truckId) return plumber;
    changed = true;
    return { ...plumber, truckId };
  });
  if (!changed) return null;
  return savePlumbers(next);
}

export function assignPlumberToTruck(
  plan: DispatchPlan,
  truckId: string,
  plumberId: string,
  plumbers: Plumber[]
): DispatchPlan {
  return {
    ...plan,
    trucks: plan.trucks.map((truck) => {
      const without = (truck.plumberIds || []).filter((id) => id !== plumberId);
      const nextIds = truck.id === truckId ? [...without, plumberId] : without;
      return withPlumberIds(truck, nextIds, plumbers);
    }),
  };
}

export function removePlumberFromTruck(
  plan: DispatchPlan,
  truckId: string,
  plumberId: string,
  plumbers: Plumber[]
): DispatchPlan {
  return {
    ...plan,
    trucks: plan.trucks.map((truck) =>
      truck.id !== truckId
        ? truck
        : withPlumberIds(
            truck,
            (truck.plumberIds || []).filter((id) => id !== plumberId),
            plumbers
          )
    ),
  };
}

export function stripPlumberFromPlan(
  plan: DispatchPlan,
  plumberId: string,
  plumbers: Plumber[]
): DispatchPlan {
  return {
    ...plan,
    trucks: plan.trucks.map((truck) =>
      withPlumberIds(
        truck,
        (truck.plumberIds || []).filter((id) => id !== plumberId),
        plumbers
      )
    ),
  };
}

export function truckAssignedToPlumber(
  plan: DispatchPlan,
  plumberId: string,
  plumbers?: Plumber[]
): DispatchTruck | undefined {
  const plumber = plumbers?.find((item) => item.id === plumberId);
  if (plumber?.truckId) {
    return plan.trucks.find((truck) => truck.id === plumber.truckId);
  }
  if (plumber?.truckId === '') return undefined;
  return plan.trucks.find((truck) => (truck.plumberIds || []).includes(plumberId));
}
