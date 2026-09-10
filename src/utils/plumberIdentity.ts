const PLUMBER_KEY = 'njPlumberId';
const DEVICE_KEY = 'njPlumberDeviceId';

export function getSavedPlumberId(): string {
  try {
    return localStorage.getItem(PLUMBER_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function savePlumberId(id: string): void {
  try {
    if (id.trim()) localStorage.setItem(PLUMBER_KEY, id.trim());
    else localStorage.removeItem(PLUMBER_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)?.trim();
    if (existing) return existing;
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return `dev-${Date.now()}`;
  }
}
