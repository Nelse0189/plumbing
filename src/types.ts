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





