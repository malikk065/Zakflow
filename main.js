const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;

// --- IndexedDB Lock-Bereinigung (verhindert hängende Firebase Auth) ---
function cleanupIndexedDBLocks() {
  const userDataPath = app.getPath('userData');
  const idbPath = path.join(userDataPath, 'IndexedDB');
  if (fs.existsSync(idbPath)) {
    try {
      const dirs = fs.readdirSync(idbPath);
      for (const dir of dirs) {
        const lockFile = path.join(idbPath, dir, 'LOCK');
        if (fs.existsSync(lockFile)) {
          try { fs.unlinkSync(lockFile); } catch (_) {}
        }
      }
    } catch (_) {}
  }
}

// --- OneDrive Pfad-Erkennung ---
function findOneDrivePath() {
  const homeDir = os.homedir();
  const candidates = [];

  if (process.platform === 'darwin') {
    // macOS: CloudStorage-Ordner
    const cloudStorage = path.join(homeDir, 'Library', 'CloudStorage');
    if (fs.existsSync(cloudStorage)) {
      try {
        const entries = fs.readdirSync(cloudStorage);
        for (const entry of entries) {
          if (entry.toLowerCase().startsWith('onedrive')) {
            candidates.push(path.join(cloudStorage, entry));
          }
        }
      } catch (_) {}
    }
    candidates.push(path.join(homeDir, 'OneDrive'));
  } else if (process.platform === 'win32') {
    // Windows: Standard OneDrive-Pfade
    candidates.push(path.join(homeDir, 'OneDrive'));
    candidates.push(path.join(homeDir, 'OneDrive - Personal'));
    // Env-Variable
    if (process.env.OneDrive) {
      candidates.push(process.env.OneDrive);
    }
    if (process.env.OneDriveConsumer) {
      candidates.push(process.env.OneDriveConsumer);
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getDefaultDataPath() {
  const oneDrive = findOneDrivePath();
  if (oneDrive) {
    return path.join(oneDrive, 'Zakflow');
  }
  // Fallback: App-lokaler Ordner
  return path.join(app.getPath('userData'), 'data');
}

function ensureDataDir(dataPath) {
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true });
  }
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Fehler beim Lesen:', filePath, e.message);
  }
  return null;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Daten-Pfad Management ---
let currentDataPath = null;

function getDataPath() {
  if (currentDataPath) return currentDataPath;

  // Versuche gespeicherten Pfad zu laden
  const configPath = path.join(app.getPath('userData'), 'config.json');
  const config = readJSON(configPath);
  if (config && config.dataPath && fs.existsSync(config.dataPath)) {
    currentDataPath = config.dataPath;
  } else {
    currentDataPath = getDefaultDataPath();
  }
  ensureDataDir(currentDataPath);
  return currentDataPath;
}

function setDataPath(newPath) {
  currentDataPath = newPath;
  ensureDataDir(newPath);
  const configPath = path.join(app.getPath('userData'), 'config.json');
  writeJSON(configPath, { dataPath: newPath });
}

// --- App erstellen ---
function createWindow() {
  const windowOptions = {
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
  };

  // macOS-spezifische Fenster-Optionen
  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 15, y: 15 };
  }

  // Windows/Linux: Menüleiste (File, Edit, View...) entfernen
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  cleanupIndexedDBLocks();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// --- IPC Handlers ---

// Settings
ipcMain.handle('settings:get', () => {
  const filePath = path.join(getDataPath(), 'settings.json');
  return readJSON(filePath) || {
    company: {
      name: '',
      address: '',
      zip: '',
      city: '',
      phone: '',
      email: '',
      website: '',
      taxNumber: '',
      vatId: '',
      bankName: '',
      iban: '',
      bic: '',
    },
    taxMode: 'kleinunternehmer', // oder 'regelbesteuerung'
    invoicePrefix: 'RE',
    nextInvoiceNumber: 1,
    logoPath: '',
  };
});

ipcMain.handle('settings:save', (_event, settings) => {
  const filePath = path.join(getDataPath(), 'settings.json');
  writeJSON(filePath, settings);
  return true;
});

// Logo Upload
ipcMain.handle('settings:uploadLogo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Logo auswählen',
    filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'svg'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const sourcePath = result.filePaths[0];
  const ext = path.extname(sourcePath);
  const destPath = path.join(getDataPath(), `logo${ext}`);

  try {
    // Alte Logo-Dateien löschen
    ['.png', '.jpg', '.jpeg', '.svg'].forEach(e => {
      const old = path.join(getDataPath(), `logo${e}`);
      if (fs.existsSync(old)) try { fs.unlinkSync(old); } catch (_) {}
    });
    fs.copyFileSync(sourcePath, destPath);
    fs.chmodSync(destPath, 0o644);
  } catch (e) {
    console.error('Logo-Upload-Fehler:', e.message);
    return null;
  }
  return destPath;
});

ipcMain.handle('settings:getLogo', () => {
  const dataPath = getDataPath();
  const extensions = ['.png', '.jpg', '.jpeg', '.svg'];
  for (const ext of extensions) {
    const logoPath = path.join(dataPath, `logo${ext}`);
    if (fs.existsSync(logoPath)) {
      return logoPath;
    }
  }
  return null;
});

ipcMain.handle('settings:readLogoBase64', (_event, logoPath) => {
  try {
    if (logoPath && fs.existsSync(logoPath)) {
      const buffer = fs.readFileSync(logoPath);
      const ext = path.extname(logoPath).toLowerCase().replace('.', '');
      const mimeType = ext === 'jpg' ? 'jpeg' : ext;
      return {
        data: buffer.toString('base64'),
        mimeType: `image/${mimeType}`,
      };
    }
  } catch (e) {
    console.error('Logo-Lesefehler:', e.message);
  }
  return null;
});

// Customers
ipcMain.handle('customers:getAll', () => {
  const filePath = path.join(getDataPath(), 'customers.json');
  return readJSON(filePath) || [];
});

ipcMain.handle('customers:save', (_event, customers) => {
  const filePath = path.join(getDataPath(), 'customers.json');
  writeJSON(filePath, customers);
  return true;
});

// Invoices
ipcMain.handle('invoices:getAll', () => {
  const filePath = path.join(getDataPath(), 'invoices.json');
  return readJSON(filePath) || [];
});

ipcMain.handle('invoices:save', (_event, invoices) => {
  const filePath = path.join(getDataPath(), 'invoices.json');
  writeJSON(filePath, invoices);
  return true;
});

// PDF automatisch in OneDrive/Daten-Ordner speichern
ipcMain.handle('pdf:saveAuto', (_event, pdfBytes, invoiceNumber) => {
  const pdfDir = path.join(getDataPath(), 'PDFs');
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  const safeNumber = (invoiceNumber || 'Rechnung').replace(/[/\\:*?"<>|]/g, '-');
  const filePath = path.join(pdfDir, `${safeNumber}.pdf`);
  const buffer = Buffer.from(pdfBytes);

  try {
    // Existierende Datei erst löschen (OneDrive-Sperre umgehen)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    fs.writeFileSync(filePath, buffer);
  } catch (e) {
    // Fallback: mit Zeitstempel speichern wenn gesperrt
    const timestamp = Date.now();
    const fallbackPath = path.join(pdfDir, `${safeNumber}_${timestamp}.pdf`);
    fs.writeFileSync(fallbackPath, buffer);
    return fallbackPath;
  }
  return filePath;
});

// PDF manuell speichern (Speichern-unter-Dialog)
ipcMain.handle('pdf:save', async (_event, pdfBytes, invoiceNumber) => {
  const safeNumber = (invoiceNumber || 'Rechnung').replace(/[/\\:*?"<>|]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Rechnung speichern',
    defaultPath: `${safeNumber}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  if (result.canceled) return null;

  const buffer = Buffer.from(pdfBytes);
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

// Data Path
ipcMain.handle('dataPath:get', () => {
  return getDataPath();
});

ipcMain.handle('dataPath:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Daten-Ordner auswählen',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const newPath = result.filePaths[0];
  setDataPath(newPath);
  return newPath;
});

// Firebase Config
ipcMain.handle('firebase:getConfig', () => {
  const filePath = path.join(getDataPath(), 'firebase-config.json');
  return readJSON(filePath) || null;
});

ipcMain.handle('firebase:saveConfig', (_event, config) => {
  const filePath = path.join(getDataPath(), 'firebase-config.json');
  writeJSON(filePath, config);
  return true;
});

ipcMain.handle('firebase:removeConfig', () => {
  const filePath = path.join(getDataPath(), 'firebase-config.json');
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return true;
});

// Expenses (Ausgaben)
ipcMain.handle('expenses:getAll', () => {
  const filePath = path.join(getDataPath(), 'expenses.json');
  return readJSON(filePath) || [];
});

ipcMain.handle('expenses:save', (_event, expenses) => {
  const filePath = path.join(getDataPath(), 'expenses.json');
  writeJSON(filePath, expenses);
  return true;
});

// Donations (Spenden)
ipcMain.handle('donations:getAll', () => {
  const filePath = path.join(getDataPath(), 'donations.json');
  return readJSON(filePath) || [];
});

ipcMain.handle('donations:save', (_event, donations) => {
  const filePath = path.join(getDataPath(), 'donations.json');
  writeJSON(filePath, donations);
  return true;
});

// Saved Items (Gespeicherte Positionen)
ipcMain.handle('savedItems:getAll', () => {
  const filePath = path.join(getDataPath(), 'saved-items.json');
  return readJSON(filePath) || [];
});

ipcMain.handle('savedItems:save', (_event, items) => {
  const filePath = path.join(getDataPath(), 'saved-items.json');
  writeJSON(filePath, items);
  return true;
});

// Auth (Login/Register)
ipcMain.handle('auth:getData', () => {
  const filePath = path.join(getDataPath(), 'auth.json');
  return readJSON(filePath);
});

ipcMain.handle('auth:setData', (_event, data) => {
  const filePath = path.join(getDataPath(), 'auth.json');
  if (data) {
    writeJSON(filePath, data);
  } else {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  return true;
});

ipcMain.handle('session:get', () => {
  const filePath = path.join(getDataPath(), 'session.json');
  return readJSON(filePath);
});

ipcMain.handle('session:set', (_event, data) => {
  const filePath = path.join(getDataPath(), 'session.json');
  if (data) {
    writeJSON(filePath, data);
  } else {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  return true;
});

// Password (legacy - keep for compatibility)
ipcMain.handle('password:get', () => {
  const filePath = path.join(getDataPath(), 'auth.json');
  const data = readJSON(filePath);
  return data ? data.passwordHash || data.hash : null;
});

ipcMain.handle('password:set', (_event, hash) => {
  const filePath = path.join(getDataPath(), 'auth.json');
  if (hash) {
    writeJSON(filePath, { passwordHash: hash });
  } else {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  return true;
});

// Dark Mode Preference
ipcMain.handle('darkMode:get', () => {
  const filePath = path.join(getDataPath(), 'preferences.json');
  const data = readJSON(filePath);
  return data ? data.darkMode : false;
});

ipcMain.handle('darkMode:set', (_event, enabled) => {
  const filePath = path.join(getDataPath(), 'preferences.json');
  const data = readJSON(filePath) || {};
  data.darkMode = enabled;
  writeJSON(filePath, data);
  return true;
});

// PDF Import - Text aus PDFs extrahieren
ipcMain.handle('pdf:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Rechnungs-PDFs importieren',
    filters: [{ name: 'PDF-Dateien', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const pdfParse = require('pdf-parse');
  const imported = [];

  for (const filePath of result.filePaths) {
    try {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      imported.push({
        filePath,
        fileName: path.basename(filePath),
        text: data.text,
      });
    } catch (err) {
      console.error(`Fehler beim Lesen von ${filePath}:`, err.message);
      imported.push({
        filePath,
        fileName: path.basename(filePath),
        text: '',
        error: err.message,
      });
    }
  }

  return imported;
});

// Fonts laden für PDF
ipcMain.handle('font:load', async (_event, fontName) => {
  // Versuche System-Fonts zu laden
  const fontPaths = [];
  if (process.platform === 'darwin') {
    fontPaths.push(path.join('/System/Library/Fonts', fontName));
    fontPaths.push(path.join('/Library/Fonts', fontName));
    fontPaths.push(path.join(os.homedir(), 'Library/Fonts', fontName));
  } else if (process.platform === 'win32') {
    fontPaths.push(path.join('C:\\Windows\\Fonts', fontName));
  }

  for (const fp of fontPaths) {
    if (fs.existsSync(fp)) {
      return fs.readFileSync(fp);
    }
  }
  return null;
});
