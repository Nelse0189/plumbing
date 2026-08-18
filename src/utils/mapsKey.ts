import { doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../firebase/config';

let cachedKey = '';

export async function resolveGoogleMapsApiKey(): Promise<string> {
  if (cachedKey) return cachedKey;

  const fromEnv = String(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }

  try {
    const snap = await getDoc(doc(db, 'appConfig', 'public'));
    const fromDoc = String(snap.data()?.googleMapsApiKey || '').trim();
    if (fromDoc) {
      cachedKey = fromDoc;
      return cachedKey;
    }
  } catch (error) {
    console.warn('Could not load Maps key from Firestore', error);
  }

  try {
    const fn = httpsCallable<Record<string, never>, { googleMapsApiKey?: string }>(
      getFunctions(),
      'getPublicAppConfig'
    );
    const result = await fn({});
    const fromFn = String(result.data.googleMapsApiKey || '').trim();
    if (fromFn) {
      cachedKey = fromFn;
      return cachedKey;
    }
  } catch (error) {
    console.warn('Could not load Maps key from Cloud Functions', error);
  }

  return '';
}
