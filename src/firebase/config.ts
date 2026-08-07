import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: "AIzaSyC-fvIUi24DLEZt83zBEy9mYt-cTeWrN4Y",
  authDomain: "nj-plumbing.firebaseapp.com",
  projectId: "nj-plumbing",
  storageBucket: "nj-plumbing.firebasestorage.app",
  messagingSenderId: "158919600954",
  appId: "1:158919600954:web:c0f23f81ff9b9e52883e03",
  measurementId: "G-TENWETD263"
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// Initialize Firestore
export const db = getFirestore(app);

