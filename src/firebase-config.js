// Firebase Konfiguration - wird vom Benutzer selbst eingetragen
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
    firebase.initializeApp(config);
    db = firebase.firestore();
    auth = firebase.auth();

    // Persistence setzen — mit Fallback falls IndexedDB kaputt ist
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
    console.log('Firebase verbunden:', config.projectId);
    return true;
  } catch (e) {
    console.error('Firebase Init Fehler:', e);
    firebaseReady = false;
    db = null;
    auth = null;
    return false;
  }
}

function getFirebaseConfig() {
  // Electron: aus lokaler Datei laden
  if (typeof window.api !== 'undefined') {
    return null; // Wird über IPC geladen
  }
  // PWA: aus localStorage laden
  const saved = localStorage.getItem('firebaseConfig');
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) { return null; }
  }
  return null;
}

function saveFirebaseConfigLocal(config) {
  // PWA: in localStorage speichern
  localStorage.setItem('firebaseConfig', JSON.stringify(config));
}
