export interface Stop {
  id: string;
  workOrderNumber?: string;
  address: string;
  customerName: string;
  phone: string;
  time: string;
  jobType?: string;
  sourceFileName?: string;
  notes?: string;
  lat?: number;
  lng?: number;
  /** Filled when the stop was created from a call/voicemail transcript */
  callSummary?: string;
  /** Actionable coaching for staff (from AI review of the transcript) */
  customerServiceTips?: string[];
}

export interface Truck {
  id: string;
  name: string;
  driver?: string;
  stops: Stop[];
}

export interface Schedule {
  date: string;
  trucks: Truck[];
}

export interface WorkOrder {
  workOrderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  jobType: string;
  appointmentDate: string;
  appointmentTime: string;
  notes: string;
  sourceFileName: string;
  smsConsent: boolean;
  confidence?: number;
  teamsTeamId?: string;
  teamsChannelId?: string;
  teamsMessageId?: string;
  teamsAttachmentId?: string;
}

export interface StoredWorkOrder extends WorkOrder {
  id: string;
  status: 'needs_review' | 'unscheduled' | 'scheduling' | 'scheduled' | 'closed';
  selectedTime?: string;
  cached?: boolean;
  callSummary?: string;
  source?: string;
}

export interface PlaudAppointmentEvidence {
  quote: string;
  start: number;
  end: number;
}

export interface PlaudCall {
  id: string;
  callDate: string;
  startedAt: string;
  recordingName?: string;
  durationMs?: number | null;
  serialNumber?: string;
  callerPhone?: string;
  transcript: string;
  plaudSummary?: string;
  summary: string;
  customerServiceTips: string[];
  appointmentMade: boolean;
  workOrderId?: string;
  appointmentEvidence?: PlaudAppointmentEvidence;
  status: 'processed' | 'needs_review' | 'failed' | 'awaiting_transcript' | 'processing' | 'in_plaud';
  error?: string;
  source?: string;
  hasSpeakerLabels?: boolean;
}

export interface PlaudConnection {
  connected: boolean;
  mode?: 'cli' | 'web';
  email?: string;
  name?: string;
  error?: string;
  libraryCount?: number;
  apiBase?: string;
  tokenType?: string;
}

export interface PlaudSyncSummary {
  scanned: number;
  matched: number;
  imported: number;
  skipped: number;
  failed: number;
  awaitingTranscript: number;
  appointments: number;
  scope?: string;
  plaudTotal?: number;
}

/** 4-hour arrival window shown to the customer (HH:MM, 24h). */
export interface ArrivalWindow {
  start: string;
  end: string;
}

export interface DispatchStop {
  id: string;
  workOrderId: string;
  workOrderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  jobType: string;
  notes: string;
  sourceFileName?: string;
  /** Higher priority runs earlier than distance order. */
  priority: number;
  window: ArrivalWindow;
  /** When true, reordering will not overwrite the plumber-edited window. */
  customWindow: boolean;
  distanceMiles?: number | null;
  lat?: number;
  lng?: number;
  morningTextStatus?: 'none' | 'queued' | 'sent' | 'failed';
  /** Temporary test-call delivery state for the arrival-window confirmation. */
  voiceCallStatus?:
    | 'queued'
    | 'ringing'
    | 'answered'
    | 'completed'
    | 'busy'
    | 'canceled'
    | 'failed'
    | 'no-answer';
  /** Customer keypad/speech answer captured during the confirmation call. */
  voiceConfirmationResponse?:
    | 'confirmed'
    | 'declined'
    | 'unknown'
    | 'no_answer'
    | 'hung_up';
  voiceConfirmationDetails?: string;
  voiceConfirmationAt?: string;
}

export interface DispatchTruck {
  id: string;
  name: string;
  driver?: string;
  /** Locked route — morning texts queue from this plan. */
  set: boolean;
  setAt?: string;
  stops: DispatchStop[];
}

export interface DispatchPlan {
  date: string;
  originAddress: string;
  trucks: DispatchTruck[];
  unassigned: DispatchStop[];
  notReady: DispatchStop[];
  updatedAt?: string;
}





