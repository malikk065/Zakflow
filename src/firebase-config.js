// Firebase Konfiguration — fest eingebaut
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDDzRp_FTJby4g2luW27EwTP10nEh6OjOU",
  authDomain: "zakflow-aeab5.firebaseapp.com",
  projectId: "zakflow-aeab5",
  storageBucket: "zakflow-aeab5.firebasestorage.app",
  messagingSenderId: "248085816349",
  appId: "1:248085816349:web:4d0826289f210b186d12f4"
};

let db = null;
let auth = null;
let firebaseReady = false;

async function initFirebase(config) {
  try {
    // Falls bereits initialisiert, App löschen und neu starten
    if (firebase.apps.length > 0) {
      for (const app of firebase.apps) {
        await app.delete();
      }
    }
    firebase.initializeApp(config || FIREBASE_CONFIG);
    db = firebase.firestore();
    auth = firebase.auth();

    // Firestore Offline-Persistence aktivieren (IndexedDB-Cache)
    try {
      await db.enablePersistence();
      console.log('Firestore Offline-Persistence aktiviert');
    } catch (e) {
      if (e.code === 'failed-precondition') {
        console.warn('Offline-Persistence: Mehrere Tabs offen, nur in einem Tab möglich');
      } else if (e.code === 'unimplemented') {
        console.warn('Offline-Persistence: Browser unterstützt es nicht');
      } else {
        console.warn('Offline-Persistence fehlgeschlagen:', e.code, e.message);
      }
    }

    // Auth Persistence setzen — mit Fallback falls IndexedDB kaputt ist
    try {
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    } catch (e) {
      console.warn('LOCAL Persistence fehlgeschlagen, nutze SESSION:', e.message);
      try {
        await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      } catch (e2) {
        console.warn('SESSION Persistence auch fehlgeschlagen, nutze NONE:', e2.message);
        await auth.setPersistence(firebase.auth.Auth.Persistence.NONE);
      }
    }

    firebaseReady = true;
    console.log('Firebase verbunden:', (config || FIREBASE_CONFIG).projectId);
    return true;
  } catch (e) {
    console.error('Firebase Init Fehler:', e);
    firebaseReady = false;
    db = null;
    auth = null;
    return false;
  }
}
