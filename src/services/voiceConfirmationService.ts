import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app);

export interface VoiceConfirmationResult {
  success: true;
  confirmationId: string;
  callSid: string;
  testRecipient: string;
  callStatus: 'queued';
}

/**
 * Starts a temporary arrival-window confirmation call. The deployed function
 * deliberately routes calls to the configured test recipient, not the stop's
 * customer phone number.
 */
export async function initiateVoiceWindowConfirmation(
  dispatchDate: string,
  truckId: string,
  stopId: string
): Promise<VoiceConfirmationResult> {
  const callable = httpsCallable<
    { dispatchDate: string; truckId: string; stopId: string },
    VoiceConfirmationResult
  >(functions, 'initiateVoiceWindowConfirmation');
  const result = await callable({ dispatchDate, truckId, stopId });
  return result.data;
}
