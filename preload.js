const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  uploadLogo: () => ipcRenderer.invoke('settings:uploadLogo'),
  getLogo: () => ipcRenderer.invoke('settings:getLogo'),
  readLogoBase64: (logoPath) => ipcRenderer.invoke('settings:readLogoBase64', logoPath),

  // Customers
  getCustomers: () => ipcRenderer.invoke('customers:getAll'),
  saveCustomers: (customers) => ipcRenderer.invoke('customers:save', customers),

  // Invoices
  getInvoices: () => ipcRenderer.invoke('invoices:getAll'),
  saveInvoices: (invoices) => ipcRenderer.invoke('invoices:save', invoices),

  // PDF
  savePDF: (pdfBytes, invoiceNumber) => ipcRenderer.invoke('pdf:save', Array.from(pdfBytes), invoiceNumber),
  saveAutoPDF: (pdfBytes, invoiceNumber) => ipcRenderer.invoke('pdf:saveAuto', Array.from(pdfBytes), invoiceNumber),

  // Data Path
  getDataPath: () => ipcRenderer.invoke('dataPath:get'),
  chooseDataPath: () => ipcRenderer.invoke('dataPath:choose'),

  // PDF Import
  importPDFs: () => ipcRenderer.invoke('pdf:import'),

  // Firebase Config
  getFirebaseConfig: () => ipcRenderer.invoke('firebase:getConfig'),
  saveFirebaseConfig: (config) => ipcRenderer.invoke('firebase:saveConfig', config),
  removeFirebaseConfig: () => ipcRenderer.invoke('firebase:removeConfig'),

  // Saved Items
  getSavedItems: () => ipcRenderer.invoke('savedItems:getAll'),
  saveSavedItems: (items) => ipcRenderer.invoke('savedItems:save', items),

  // Auth
  getAuthData: () => ipcRenderer.invoke('auth:getData'),
  setAuthData: (data) => ipcRenderer.invoke('auth:setData', data),
  getSession: () => ipcRenderer.invoke('session:get'),
  setSession: (data) => ipcRenderer.invoke('session:set', data),

  // Password (legacy)
  getPasswordHash: () => ipcRenderer.invoke('password:get'),
  setPasswordHash: (hash) => ipcRenderer.invoke('password:set', hash),

  // Dark Mode
  getDarkMode: () => ipcRenderer.invoke('darkMode:get'),
  setDarkMode: (enabled) => ipcRenderer.invoke('darkMode:set', enabled),

  // Font
  loadFont: (fontName) => ipcRenderer.invoke('font:load', fontName),
});
