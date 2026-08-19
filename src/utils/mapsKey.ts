import { getApp } from 'firebase/app';
import { doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../firebase/config';

let cachedKey = '';

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

export async function resolveGoogleMapsApiKey(): Promise<string> {
  if (cachedKey) return cachedKey;

  const fromEnv = String(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }

  try {
    const snap = await withTimeout(getDoc(doc(db, 'appConfig', 'public')), 6000, null);
    const fromDoc = String(snap?.data()?.googleMapsApiKey || '').trim();
    if (fromDoc) {
      cachedKey = fromDoc;
      return cachedKey;
    }
  } catch (error) {
    console.warn('Could not load Maps key from Firestore', error);
  }

  try {
    const fn = httpsCallable<Record<string, never>, { googleMapsApiKey?: string }>(
      getFunctions(getApp(), 'us-central1'),
      'getPublicAppConfig',
      { timeout: 15000 }
    );
    const result = await withTimeout(fn({}), 15000, null);
    const fromFn = String(result?.data.googleMapsApiKey || '').trim();
    if (fromFn) {
      cachedKey = fromFn;
      return cachedKey;
    }
  } catch (error) {
    console.warn('Could not load Maps key from Cloud Functions', error);
  }

  return '';
}
