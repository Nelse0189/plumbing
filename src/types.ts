export interface Stop {
  id: string;
  address: string;
  customerName: string;
  phone: string;
  time: string;
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

export type WorkOrderLineCategory = 'labor' | 'material' | 'trip' | 'other';

export interface WorkOrderLineItem {
  id: string;
  description: string;
  category: WorkOrderLineCategory;
  quantity: number;
  unitPrice: number;
}

export type WorkOrderStatus = 'draft' | 'ready' | 'billed';

export interface WorkOrder {
  id: string;
  workOrderNumber: string;
  date: string;
  customerName: string;
  address: string;
  phone: string;
  truckName?: string;
  technician?: string;
  jobDescription: string;
  notes: string;
  /** Present when this work order was created from a scheduled stop */
  sourceStopId?: string;
  lineItems: WorkOrderLineItem[];
  status: WorkOrderStatus;
}

export interface BillingOrder {
  id: string;
  billingOrderNumber: string;
  createdAt: string;
  workOrderNumbers: string[];
  customerName: string;
  address: string;
  phone: string;
  jobDate: string;
  lineItems: WorkOrderLineItem[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes: string;
}





