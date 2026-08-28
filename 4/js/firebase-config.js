// ============================================================
// FIREBASE CONFIG — replace with YOUR project's values.
// Firebase Console → Project Settings → General → Your apps → SDK config
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Offline persistence — this is what makes commissioner offline entry work.
// Firestore caches reads locally and QUEUES writes made while offline,
// then automatically syncs them the instant connectivity returns. No custom
// sync code needed for this part; it's built into the SDK.
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Offline persistence needs a single tab open — multiple tabs detected.");
  } else if (err.code === "unimplemented") {
    console.warn("This browser doesn't support offline persistence.");
  }
});

// ============================================================
// COLLEGE FOOTBALL DATA (collegefootballdata.com) — free API key.
// Get one at https://collegefootballdata.com/key
// ============================================================
export const CFBD_API_KEY = "YOUR_CFBD_API_KEY";

// ============================================================
// Commissioner unlock code — anyone entering this at login gets
// commissioner powers on their account. Change this before you
// share the app with the group if you want it to stay a secret.
// ============================================================
export const COMMISSIONER_CODE = "buns";
