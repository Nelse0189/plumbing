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
}

export interface StoredWorkOrder extends WorkOrder {
  id: string;
  status: 'unscheduled' | 'scheduling' | 'scheduled';
  selectedTime?: string;
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





