export type NativeTrackPayload = {
  plumberId: string;
  shiftId: string;
  deviceId: string;
};

type PlumberClockBridge = {
  postMessage: (message: string) => void;
};

function plumberClockBridge(): PlumberClockBridge | null {
  const handler = (
    window as Window & {
      webkit?: { messageHandlers?: { plumberClock?: PlumberClockBridge } };
    }
  ).webkit?.messageHandlers?.plumberClock;
  return handler || null;
}

export function isPlumberNativeApp(): boolean {
  return Boolean(plumberClockBridge());
}

export function nativeStartTracking(payload: NativeTrackPayload): void {
  plumberClockBridge()?.postMessage(
    JSON.stringify({ type: 'clockIn', ...payload })
  );
}

export function nativeStopTracking(): void {
  plumberClockBridge()?.postMessage(JSON.stringify({ type: 'clockOut' }));
}

export function nativeRequestAlwaysLocation(): void {
  plumberClockBridge()?.postMessage(JSON.stringify({ type: 'requestLocation' }));
}
