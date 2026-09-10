export interface Stop {
  id: string;
  workOrderNumber?: string;
  address: string;
  customerName: string;
  phone: string;
  /** All customer numbers on the job, including `phone`. */
  phones?: string[];
  time: string;
  jobType?: string;
  sourceFileName?: string;
  installDescription?: string;
  notes?: string;
  scheduleEvidenceQuote?: string;
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
  /** All customer numbers from the PDF/thread, E.164. Includes `phone`. */
  phones?: string[];
  address: string;
  jobType: string;
  appointmentDate: string;
  appointmentTime: string;
  notes: string;
  /** Verbatim span from notes that booked the service day (from AI). */
  scheduleEvidenceQuote?: string;
  /** Heater/install line from the sales-order PDF, without price. */
  installDescription?: string;
  /** Requested/install date printed on a related work-order PDF. */
  pdfServiceDate?: string;
  /** Set when Teams notes mark this as a repeat of another work order. */
  duplicateOfWorkOrderNumber?: string;
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
  /** Set when staff picked the service day by hand; AI must not change it. */
  manualSchedule?: boolean;
  selectedTime?: string;
  cached?: boolean;
  callSummary?: string;
  source?: string;
  autoImported?: boolean;
  mock?: boolean;
  /** Office checklist: town permit has been pulled. */
  permitPulled?: boolean;
  permitPulledAt?: string;
  /** Office checklist: job uploaded to Home Depot / Lowe's. */
  retailerUploaded?: boolean;
  retailerUploadedAt?: string;
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
  workOrderNumber?: string;
  appointmentEvidence?: PlaudAppointmentEvidence;
  reviewReasons?: string[];
  customerName?: string;
  phone?: string;
  address?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  costUsd?: number;
  status: 'processed' | 'needs_review' | 'failed' | 'awaiting_transcript' | 'processing' | 'in_plaud';
  error?: string;
  source?: string;
  hasSpeakerLabels?: boolean;
  /** ISO time the dispatcher confirmed and posted this schedule into Teams. */
  teamsPostedAt?: string;
  teamsPostedMessageId?: string;
  teamsPostedTeamId?: string;
  teamsPostedChannelId?: string;
  teamsPostedWebUrl?: string;
  teamsPostedAsReply?: boolean;
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
  processed?: number;
  saved?: number;
  remaining?: number;
  incomplete?: boolean;
  costUsd?: number;
  scope?: string;
  plaudTotal?: number;
}

/** Arrival window shown to the customer (HH:MM, 24h). */
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
  /** All customer numbers on the job, including `phone`. */
  phones?: string[];
  address: string;
  jobType: string;
  notes: string;
  scheduleEvidenceQuote?: string;
  sourceFileName?: string;
  /** Heater/install line from the sales-order PDF, without price. */
  installDescription?: string;
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
  voiceWantsHumanCallback?: boolean;
  voiceHumanCallbackDetails?: string;
  /** Latest voiceConfirmations document for this stop. */
  voiceConfirmationId?: string;
  /** ElevenLabs ConvAI conversation id used to download the recording. */
  voiceConversationId?: string;
  /** Window last told to the customer by SMS. If this differs from `window`, the default text is the update wording. */
  windowSmsNotifiedKey?: string;
  /** Marked cancelled on Ready / Unassigned; not treated as an active truck stop. */
  cancelled?: boolean;
  /**
   * Set when the work order's service date moved off this day (Teams note,
   * manual reschedule). The stop shows as cancelled here with the new date;
   * empty string means the job was taken off the schedule entirely.
   */
  movedToDate?: string;
  /**
   * Stop this card was copied from when the same work order is on more than
   * one truck (two crews to the same job).
   */
  copiedFromStopId?: string;
}

export interface Plumber {
  id: string;
  name: string;
  /**
   * Truck this plumber is assigned to.
   * Missing means not saved yet (fall back to the day’s plan).
   * Empty string means explicitly unassigned.
   */
  truckId?: string;
}

export interface TruckPhone {
  id: string;
  /** Optional crew name shown on the truck card. */
  label: string;
  /** Normalized US number, usually +1XXXXXXXXXX. */
  phone: string;
}

export interface DispatchTruck {
  id: string;
  name: string;
  driver?: string;
  /** Roster plumber ids assigned to this truck. */
  plumberIds?: string[];
  /** Locked route — morning texts queue from this plan. */
  set: boolean;
  setAt?: string;
  /** Same-day pump receipt, used to flag overspend vs the route budget. */
  gasReceiptUsd?: number | null;
  stops: DispatchStop[];
}

export interface TruckFuelProfile {
  mpg?: number;
}

export interface NearbyGasStation {
  id: string;
  name: string;
  address: string;
  miles: number;
  pricePerGallon: number | null;
  priceUpdatedAt?: string;
}

export interface FuelSettings {
  /** Shop override. When set, this wins over nearby Places / EIA prices. */
  pricePerGallon: number | null;
  defaultMpg: number;
  includeReturnToShop: boolean;
  idleBufferPct: number;
  highPriceDelta: number;
  tankGallons: number;
  trucks: Record<string, TruckFuelProfile>;
  eiaPricePerGallon?: number | null;
  eiaPeriod?: string;
  /** Cheapest regular unleaded from Google Places near the shop. */
  placesPricePerGallon?: number | null;
  placesStationName?: string;
  placesStationId?: string;
  placesFetchedAt?: string;
  placesStations?: NearbyGasStation[];
  updatedAt?: string;
}

export type GasMilesSource = 'directions' | 'haversine' | 'none';
export type GasReceiptFlag = 'ok' | 'fill_up' | 'high' | 'none';

export interface TruckGasEstimate {
  truckId: string;
  truckName: string;
  stopCount: number;
  miles: number;
  gallons: number;
  mpg: number;
  pricePerGallon: number;
  routeCostUsd: number;
  budgetUsd: number;
  tankFillUsd: number;
  highPumpPrice: number;
  milesSource: GasMilesSource;
  receiptUsd?: number | null;
  receiptFlag: GasReceiptFlag;
}

export interface DispatchPlan {
  date: string;
  originAddress: string;
  trucks: DispatchTruck[];
  unassigned: DispatchStop[];
  notReady: DispatchStop[];
  updatedAt?: string;
}

export interface JobTicketMaterial {
  description: string;
  qty: string;
  amount: string;
}

export interface JobTicket {
  id: string;
  workOrderId?: string;
  workOrderNumber: string;
  customerName: string;
  phone: string;
  phones?: string[];
  address: string;
  street: string;
  city: string;
  zip: string;
  jobType: string;
  serviceDate: string;
  workPerformed: string;
  followUpNotes: string;
  heaterModel: string;
  serialNumber: string;
  heaterLocation: string;
  tankWarrantyYears: string;
  dwellingType: string;
  heaterPrice: string;
  permitAmount: string;
  materials: JobTicketMaterial[];
  extraCharges: JobTicketMaterial[];
  laborAmount: string;
  totalAmount: string;
  plumberName: string;
  paymentMethod: string;
  driversLicense: string;
  cardOrCheckNumber: string;
  routingNumber: string;
  cardExp: string;
  amountPaid: string;
  customerSignedName: string;
  customerSignature: string;
  customerInitial: string;
  signedAt?: string;
  authorizationAccepted: boolean;
  status: 'draft' | 'signed';
  /** Work-order sheet: 1-800 Heaters original or N&J Plumbing logo. */
  formTemplate?: 'heaters' | 'nj';
  /** Overlay and PDF text size in px. Smaller values fit more in a box. */
  pdfFontSize?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type JobTicketAuditAction = 'created' | 'saved' | 'signed' | 'amended' | 'deleted';

export interface JobTicketAuditChange {
  from: string;
  to: string;
}

export interface JobTicketAuditEvent {
  id: string;
  at?: string;
  clientAt: string;
  action: JobTicketAuditAction;
  changes: Record<string, JobTicketAuditChange>;
  prevHash: string;
  hash: string;
}

export type TimeClockOutSource = 'manual' | 'auto-shop' | 'auto-stale' | 'office';

export interface TimeGpsPoint {
  lat: number;
  lng: number;
  accuracy?: number;
  at?: string;
}

export interface TimeShift {
  id: string;
  plumberId: string;
  plumberName: string;
  truckId?: string;
  date: string;
  status: 'open' | 'closed';
  clockInAt: string;
  clockOutAt?: string;
  clockOutSource?: TimeClockOutSource;
  clockIn?: TimeGpsPoint;
  clockOut?: TimeGpsPoint;
  lastPingAt?: string;
  lastPing?: TimeGpsPoint;
  leftShop?: boolean;
  shopArrivedAt?: string;
  deviceId?: string;
}





