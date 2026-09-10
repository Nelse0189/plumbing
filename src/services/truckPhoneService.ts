import {
  doc,
  onSnapshot,
  setDoc,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { smsPhoneDigits } from './phoneSmsService';
import type { TruckPhone } from '../types';

const TRUCK_PHONES_DOC = doc(db, 'appConfig', 'truckPhones');
const MAX_LABEL_LENGTH = 40;
const MAX_PHONES_PER_TRUCK = 8;

export type TruckPhoneRoster = Record<string, TruckPhone[]>;

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function newPhoneId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTruckPhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed;
}

export function formatTruckPhone(phone: string): string {
  const digits = smsPhoneDigits(phone);
  if (digits.length !== 10) return phone.trim() || phone;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function truckPhoneDisplayName(entry: TruckPhone): string {
  const number = formatTruckPhone(entry.phone);
  return entry.label ? `${entry.label} · ${number}` : number;
}

function mapPhone(value: unknown): TruckPhone | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const phone = normalizeTruckPhone(asText(record.phone));
  if (smsPhoneDigits(phone).length !== 10) return null;
  return {
    id: asText(record.id) || newPhoneId(),
    label: asText(record.label).slice(0, MAX_LABEL_LENGTH),
    phone,
  };
}

function mapTruckPhones(value: unknown): TruckPhone[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const phones: TruckPhone[] = [];
  for (const item of value) {
    const mapped = mapPhone(item);
    if (!mapped) continue;
    const key = smsPhoneDigits(mapped.phone);
    if (!key || seen.has(key) || seen.has(mapped.id)) continue;
    seen.add(key);
    seen.add(mapped.id);
    phones.push(mapped);
    if (phones.length >= MAX_PHONES_PER_TRUCK) break;
  }
  return phones;
}

export function mapTruckPhoneRoster(value: unknown): TruckPhoneRoster {
  if (!value || typeof value !== 'object') return {};
  const roster: TruckPhoneRoster = {};
  for (const [truckId, phones] of Object.entries(value as Record<string, unknown>)) {
    const id = asText(truckId);
    if (!id) continue;
    roster[id] = mapTruckPhones(phones);
  }
  return roster;
}

export function phonesForTruck(
  roster: TruckPhoneRoster,
  truckId: string
): TruckPhone[] {
  return roster[truckId] || [];
}

export function subscribeTruckPhones(
  onChange: (roster: TruckPhoneRoster) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    TRUCK_PHONES_DOC,
    (snap) => {
      onChange(mapTruckPhoneRoster(snap.data()?.trucks));
    },
    (error) => {
      onError?.(error);
    }
  );
}

async function saveRoster(roster: TruckPhoneRoster): Promise<TruckPhoneRoster> {
  const trucks = mapTruckPhoneRoster(roster);
  await setDoc(
    TRUCK_PHONES_DOC,
    {
      trucks,
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
  return trucks;
}

export async function addTruckPhone(
  roster: TruckPhoneRoster,
  truckId: string,
  input: { phone: string; label?: string }
): Promise<TruckPhoneRoster> {
  const phone = normalizeTruckPhone(input.phone);
  if (smsPhoneDigits(phone).length !== 10) {
    throw new Error('Enter a 10-digit US phone number.');
  }
  const current = phonesForTruck(roster, truckId);
  if (current.length >= MAX_PHONES_PER_TRUCK) {
    throw new Error(`A truck can have at most ${MAX_PHONES_PER_TRUCK} numbers.`);
  }
  const duplicate = current.some(
    (entry) => smsPhoneDigits(entry.phone) === smsPhoneDigits(phone)
  );
  if (duplicate) {
    throw new Error(`${formatTruckPhone(phone)} is already on this truck.`);
  }
  return saveRoster({
    ...roster,
    [truckId]: [
      ...current,
      {
        id: newPhoneId(),
        label: asText(input.label).slice(0, MAX_LABEL_LENGTH),
        phone,
      },
    ],
  });
}

export async function removeTruckPhone(
  roster: TruckPhoneRoster,
  truckId: string,
  phoneId: string
): Promise<TruckPhoneRoster> {
  return saveRoster({
    ...roster,
    [truckId]: phonesForTruck(roster, truckId).filter((entry) => entry.id !== phoneId),
  });
}
