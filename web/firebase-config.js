// Firebase Konfiguration - wird vom Benutzer selbst eingetragen
let db = null;
let firebaseReady = false;

function initFirebase(config) {
  try {
    // Falls bereits initialisiert, nicht nochmal
    if (firebase.apps.length > 0) {
      firebase.apps.forEach(app => app.delete());
    }
    firebase.initializeApp(config);
    db = firebase.firestore();
    firebaseReady = true;
    console.log('Firebase verbunden:', config.projectId);
    return true;
  } catch (e) {
    console.error('Firebase Init Fehler:', e);
    firebaseReady = false;
    db = null;
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
