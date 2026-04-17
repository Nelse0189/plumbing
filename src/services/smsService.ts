import { httpsCallable } from "firebase/functions";
import { getApps, initializeApp } from "firebase/app";
import { getFunctions as getFunctionsModule } from "firebase/functions";
import { firebaseConfig } from "../firebase/config";

// Initialize Firebase app if not already initialized
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const functions = getFunctionsModule(app);

interface ScheduleRequest {
  phoneNumber: string;
  customerName: string;
  address: string;
  date: string;
  availableTimeSlots: string[];
}

export async function initiateSMScheduling(
  phoneNumber: string,
  customerName: string,
  address: string,
  date: string,
  availableTimeSlots: string[]
): Promise<{ success: boolean; messageSid?: string }> {
  try {
    const initiateScheduling = httpsCallable<ScheduleRequest, { success: boolean; messageSid?: string }>(
      functions,
      "initiateScheduling"
    );

    const result = await initiateScheduling({
      phoneNumber,
      customerName,
      address,
      date,
      availableTimeSlots,
    });

    return result.data;
  } catch (error) {
    console.error("Error initiating SMS scheduling:", error);
    throw error;
  }
}

