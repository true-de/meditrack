/* ============================================================
   MediTrack — firebase-config.js
   ------------------------------------------------------------
   PHASE 3 STEP: replace every "YOUR_..." value below with the
   web config from your Firebase project:
     Firebase Console → Project settings → Your apps → Web app
     → SDK setup and configuration → Config
   These keys are NOT secret (they are safe to expose in a
   browser). Your data is protected by Firestore security rules.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
};

/** True only once the placeholders above have been replaced. */
export const isFirebaseConfigured = !Object.values(firebaseConfig).some(
  (value) => !value || String(value).startsWith("YOUR_")
);

let app = null;
let auth = null;
let db = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

export { app, auth, db };
