import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase/config';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctions(app);

export type VoiceCallRoute = 'customer' | '8605439082' | '8609643025';

export interface VoiceConfirmationResult {
  success: true;
  confirmationId: string;
  callSid: string;
  to: string;
  callStatus: 'queued';
  route?: VoiceCallRoute;
  testing?: boolean;
}

/**
 * Starts an arrival-window confirmation call to the selected route.
 */
export async function initiateVoiceWindowConfirmation(
  dispatchDate: string,
  truckId: string,
  stopId: string,
  route: VoiceCallRoute,
  toPhone?: string
): Promise<VoiceConfirmationResult> {
  const callable = httpsCallable<
    {
      dispatchDate: string;
      truckId: string;
      stopId: string;
      route: VoiceCallRoute;
      toPhone?: string;
    },
    VoiceConfirmationResult
  >(functions, 'initiateVoiceWindowConfirmation');
  const result = await callable({
    dispatchDate,
    truckId,
    stopId,
    route,
    ...(toPhone ? { toPhone } : {}),
  });
  return result.data;
}

export function voiceConfirmationAudioUrl(
  confirmationId: string,
  download = false
): string {
  const params = new URLSearchParams({ confirmationId });
  if (download) params.set('download', '1');
  return `https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/playVoiceConfirmationAudio?${params}`;
}

export async function downloadVoiceConfirmationAudio(
  confirmationId: string
): Promise<Blob> {
  const response = await fetch(voiceConfirmationAudioUrl(confirmationId));
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      detail.trim().slice(0, 220) ||
        `Could not download the call recording (${response.status}).`
    );
  }
  return response.blob();
}
