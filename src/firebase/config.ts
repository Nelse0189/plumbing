import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: "AIzaSyCeovABoXmIHVC2CPK-S2R2uX0Y09PM_Xc",
  authDomain: "njplu-94cdd.firebaseapp.com",
  projectId: "njplu-94cdd",
  storageBucket: "njplu-94cdd.firebasestorage.app",
  messagingSenderId: "273915227146",
  appId: "1:273915227146:web:47cd572d8cce085fb203f3",
  measurementId: "G-PW142KMQGM"
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// Initialize Firestore
export const db = getFirestore(app);

