/* ============================================================
   MediTrack – Firebase Web SDK configuration
   ------------------------------------------------------------
   These are PUBLIC client identifiers for the Firebase Web app
   "meditrack-web" in project meditrack-3a681. Firebase documents
   this object as safe to ship to the browser — it is NOT a secret
   and it is NOT the Admin SDK / service-account credential.

   The service-account private key stays on the server only. The
   Flask backend independently verifies every ID token, so holding
   this web config never grants access to anyone else's data.
   ============================================================ */
window.MEDITRACK_FIREBASE_CONFIG = {
    apiKey: "AIzaSyClhvRgySFSKA1vonbq8ZAxCy2p04d2Hhw",
    authDomain: "meditrack-3a681.firebaseapp.com",
    projectId: "meditrack-3a681",
    storageBucket: "meditrack-3a681.firebasestorage.app",
    messagingSenderId: "366189009690",
    appId: "1:366189009690:web:f31d2ea29d73ee75b06aa3",
    measurementId: "G-T008PFXT1P"
};
