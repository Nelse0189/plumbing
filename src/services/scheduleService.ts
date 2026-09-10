import { 
  doc, 
  getDoc, 
  setDoc, 
  Timestamp 
} from "firebase/firestore";
import { db } from "../firebase/config";
import type { Schedule, Truck } from "../types";

const SCHEDULES_COLLECTION = "schedules";

export async function getSchedule(date: string): Promise<Schedule | null> {
  try {
    const scheduleRef = doc(db, SCHEDULES_COLLECTION, date);
    const scheduleSnap = await getDoc(scheduleRef);
    
    if (scheduleSnap.exists()) {
      const data = scheduleSnap.data();
      return {
        date: data.date,
        trucks: data.trucks,
      };
    }
    return null;
  } catch (error) {
    console.error("Error getting schedule:", error);
    throw error;
  }
}

export async function saveSchedule(schedule: Schedule): Promise<void> {
  try {
    const scheduleRef = doc(db, SCHEDULES_COLLECTION, schedule.date);
    await setDoc(scheduleRef, {
      date: schedule.date,
      trucks: schedule.trucks,
      updatedAt: Timestamp.now(),
    });
  } catch (error) {
    console.error("Error saving schedule:", error);
    throw error;
  }
}

export async function getTrucksForDate(date: string): Promise<Truck[]> {
  const schedule = await getSchedule(date);
  return schedule?.trucks || [
    { id: 'truck1', name: 'Truck 1', stops: [] },
    { id: 'truck2', name: 'Truck 2', stops: [] },
    { id: 'truck3', name: 'Truck 3', stops: [] },
    { id: 'truck4', name: 'Truck 4', stops: [] },
    { id: 'truck5', name: 'Truck 5', stops: [] },
    { id: 'truck6', name: 'Truck 6', stops: [] },
    { id: 'truck7', name: 'Truck 7', stops: [] },
  ];
}


