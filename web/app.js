// --- PWA App Logic (Mobile Version) ---
let currentInvoiceItems = [];
let editingInvoiceId = null;
let savedItems = [];
let darkMode = false;

// --- Service Worker ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  darkMode = localStorage.getItem('darkMode') === 'true';
  applyDarkMode();

  // Firebase Config aus localStorage laden
  const savedConfig = localStorage.getItem('firebaseConfig');
  if (savedConfig) {
    try {
      const config = JSON.parse(savedConfig);
      const ok = initFirebase(config);
      if (ok) store.useFirebase = true;
    } catch (e) { console.warn('Firebase config parse error:', e); }
  }

  // Wenn keine Firebase Config → Setup-Hinweis zeigen
  if (!firebaseReady) {
    showFirebaseSetup();
    return;
  }

  // Passwort prüfen
  try {
    const doc = await db.collection('app').doc('auth').get();
    if (doc.exists && doc.data().hash) {
      document.getElementById('password-overlay').style.display = 'flex';
      document.getElementById('password-input').focus();
      return;
    }
  } catch (e) { console.warn('Auth check failed:', e); }

  await initApp();
});

function showFirebaseSetup() {
  document.querySelector('.app').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;padding:20px;">
      <div style="max-width:400px;text-align:center;">
        <h2 style="margin-bottom:8px;">&#9729; Cloud verbinden</h2>
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">
          Füge deine eigene Firebase Config ein, um die App zu nutzen.
          <a href="https://console.firebase.google.com" target="_blank" style="color:var(--accent);">Firebase Console</a>
        </p>
        <textarea id="pwa-firebase-input" rows="8" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:12px;font-family:monospace;background:var(--bg-secondary);color:var(--text-primary);margin-bottom:12px;"
          placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}'></textarea>
        <button class="btn btn-primary" style="width:100%;" onclick="connectFirebasePWA()">Verbinden</button>
      </div>
    </div>
  `;
}

function parseFirebaseConfig(input) {
  try {
    const parsed = JSON.parse(input);
    if (parsed.apiKey) return parsed;
  } catch (_) {}

  let cleaned = input.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const match = cleaned.match(/\{[^{}]*apiKey[^{}]*\}/s);
  if (match) {
    let configStr = match[0];
    configStr = configStr.replace(/(\w+)\s*:/g, '"$1":');
    configStr = configStr.replace(/""+/g, '"');
    configStr = configStr.replace(/;\s*$/, '');
    configStr = configStr.replace(/,\s*}/g, '}');
    try { return JSON.parse(configStr); } catch (_) {}
  }
  return null;
}

async function connectFirebasePWA() {
  const input = document.getElementById('pwa-firebase-input').value.trim();
  const config = parseFirebaseConfig(input);
  if (!config || !config.apiKey || !config.projectId) {
    alert('Config konnte nicht erkannt werden');
    return;
  }

  const ok = initFirebase(config);
  if (ok) {
    localStorage.setItem('firebaseConfig', JSON.stringify(config));
    store.useFirebase = true;
    location.reload();
  } else {
    alert('Firebase Verbindung fehlgeschlagen');
  }
}

async function initApp() {
  await store.loadSettings();
  await store.loadCustomers();
  await store.loadInvoices();

  // Saved items aus Firestore
  try {
    const doc = await db.collection('app').doc('savedItems').get();
    if (doc.exists) savedItems = doc.data().items || [];
  } catch (e) { console.warn('Saved items load failed:', e); }

  // Echtzeit-Sync starten
  store.onDataChanged = (type) => {
    if (type === 'customers') {
      renderCustomersList();
      updateInvoiceForm();
    }
    if (type === 'invoices') {
      renderDashboard();
    }
    if (type === 'settings') {
      renderSettingsForm();
      updateInvoiceForm();
    }
  };
  store.startRealtimeSync();

  renderDashboard();
  renderCustomersList();
  renderSettingsForm();
  updateInvoiceForm();
  updateNumberPreview();
  updatePasswordStatus();
}

// --- Navigation ---
function switchTab(tabName) {
  document.querySelectorAll('.mobile-nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

  const navItem = document.querySelector(`.mobile-nav-item[data-tab="${tabName}"]`);
  const tabContent = document.getElementById(`tab-${tabName}`);

  if (navItem) navItem.classList.add('active');
  if (tabContent) tabContent.classList.add('active');

  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'customers') renderCustomersList();
  if (tabName === 'new-invoice') updateInvoiceForm();
}

// --- Toast ---
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast show ' + type;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// --- Format ---
function formatCurrency(amount) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('de-DE');
}

// ==========================
// PASSWORD
// ==========================
async function simpleHash(str) {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkPassword() {
  const input = document.getElementById('password-input').value;
  const inputHash = await simpleHash(input);

  try {
    const doc = await db.collection('app').doc('auth').get();
    if (doc.exists && doc.data().hash === inputHash) {
      document.getElementById('password-overlay').style.display = 'none';
      await initApp();
      return;
    }
  } catch (e) { console.error('Auth error:', e); }

  document.getElementById('password-error').style.display = 'block';
  document.getElementById('password-input').value = '';
  document.getElementById('password-input').focus();
}

async function setAppPassword() {
  const pw = document.getElementById('settings-password').value.trim();
  if (!pw) { showToast('Bitte ein Passwort eingeben', 'error'); return; }
  const hash = await simpleHash(pw);
  await db.collection('app').doc('auth').set({ hash });
  document.getElementById('settings-password').value = '';
  updatePasswordStatus();
  showToast('Passwort gesetzt', 'success');
}

async function removeAppPassword() {
  await db.collection('app').doc('auth').delete();
  updatePasswordStatus();
  showToast('Passwort entfernt', 'success');
}

async function updatePasswordStatus() {
  const label = document.getElementById('password-status-label');
  try {
    const doc = await db.collection('app').doc('auth').get();
    if (label) label.textContent = (doc.exists && doc.data().hash) ? 'Passwort: aktiv' : 'Passwort: nicht gesetzt';
  } catch (e) {
    if (label) label.textContent = 'Passwort: nicht gesetzt';
  }
}

// ==========================
// DARK MODE
// ==========================
function applyDarkMode() {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  const btn = document.getElementById('dark-mode-btn');
  if (btn) btn.textContent = darkMode ? '☀️ Hellmodus' : '🌙 Dunkelmodus';
}

function toggleDarkMode() {
  darkMode = !darkMode;
  localStorage.setItem('darkMode', darkMode);
  applyDarkMode();
}

// ==========================
// SEARCH
// ==========================
function filterInvoices() {
  const query = document.getElementById('search-invoices').value.toLowerCase().trim();
  document.querySelectorAll('#invoices-list .card-item').forEach(card => {
    card.style.display = card.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

function filterCustomers() {
  const query = document.getElementById('search-customers').value.toLowerCase().trim();
  document.querySelectorAll('#customers-list .card-item').forEach(card => {
    card.style.display = card.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

// ==========================
// DASHBOARD
// ==========================
function renderDashboard() {
  const invoices = store.invoices;
  const total = invoices.length;
  const open = invoices.filter(i => i.status === 'offen').length;
  const paid = invoices.filter(i => i.status === 'bezahlt').length;

  let revenue = 0;
  invoices.filter(i => i.status === 'bezahlt').forEach(i => {
    revenue += store.calculateInvoiceTotal(i).brutto;
  });

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-open').textContent = open;
  document.getElementById('stat-paid').textContent = paid;
  document.getElementById('stat-revenue').textContent = formatCurrency(revenue);

  const list = document.getElementById('invoices-list');
  const empty = document.getElementById('dashboard-empty');

  if (invoices.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  list.style.display = '';
  empty.style.display = 'none';

  const sorted = [...invoices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  list.innerHTML = sorted.map(inv => {
    const totals = store.calculateInvoiceTotal(inv);
    const customer = store.getCustomer(inv.customerId);
    const isGutschrift = inv.type === 'gutschrift';
    const statusClass = isGutschrift ? 'badge-credit' : inv.status === 'bezahlt' ? 'badge-paid' : inv.status === 'storniert' ? 'badge-cancelled' : 'badge-open';
    const statusText = isGutschrift ? 'Gutschrift' : inv.status;

    return `<div class="card-item">
      <div class="card-item-header">
        <strong>${inv.number}</strong>
        <span class="badge ${statusClass}">${statusText}</span>
      </div>
      <div class="card-item-body">
        ${customer ? customer.name : 'Unbekannt'} &middot; ${formatDate(inv.date)} &middot; ${isGutschrift ? '-' : ''}${formatCurrency(totals.brutto)}
      </div>
      <div class="card-item-actions">
        <button class="btn-icon" onclick="exportInvoicePDF('${inv.id}')">&#128196;</button>
        <button class="btn-icon" onclick="editInvoice('${inv.id}')">&#9998;</button>
        <button class="btn-icon" onclick="toggleInvoiceStatus('${inv.id}')">&#10003;</button>
        ${!isGutschrift ? `<button class="btn-icon" onclick="createGutschrift('${inv.id}')">&#8617;</button>` : ''}
        <button class="btn-icon" onclick="deleteInvoice('${inv.id}')">&#128465;</button>
      </div>
    </div>`;
  }).join('');
}

async function toggleInvoiceStatus(id) {
  const inv = store.getInvoice(id);
  if (!inv) return;
  await store.updateInvoice(id, { status: inv.status === 'offen' ? 'bezahlt' : 'offen' });
  renderDashboard();
  showToast('Status aktualisiert', 'success');
}

async function deleteInvoice(id) {
  if (!confirm('Rechnung wirklich loeschen?')) return;
  await store.deleteInvoice(id);
  renderDashboard();
  showToast('Rechnung geloescht');
}

function editInvoice(id) {
  const inv = store.getInvoice(id);
  if (!inv) return;
  editingInvoiceId = id;
  document.getElementById('invoice-edit-id').value = id;
  document.getElementById('invoice-form-title').textContent = 'Rechnung ' + inv.number;
  document.getElementById('invoice-customer').value = inv.customerId || '';
  document.getElementById('invoice-date').value = inv.date || '';
  document.getElementById('invoice-due-days').value = inv.dueDays || 14;
  document.getElementById('invoice-payment-method').value = inv.paymentMethod || 'ueberweisung';
  document.getElementById('invoice-notes').value = inv.notes || '';
  currentInvoiceItems = JSON.parse(JSON.stringify(inv.items || []));
  renderInvoiceItems();
  recalculateInvoice();
  switchTab('new-invoice');
}

// ==========================
// GUTSCHRIFT
// ==========================
async function createGutschrift(invoiceId) {
  const inv = store.getInvoice(invoiceId);
  if (!inv || !confirm('Gutschrift fuer ' + inv.number + ' erstellen?')) return;

  const gutschrift = await store.addInvoice({
    customerId: inv.customerId,
    date: new Date().toISOString().split('T')[0],
    dueDays: 0,
    paymentMethod: inv.paymentMethod || 'ueberweisung',
    notes: 'Gutschrift zu Rechnung ' + inv.number,
    items: inv.items.map(i => ({ ...i })),
    taxMode: inv.taxMode || store.settings.taxMode,
    type: 'gutschrift',
    relatedInvoice: inv.number,
  });

  gutschrift.type = 'gutschrift';
  gutschrift.status = 'gutschrift';
  gutschrift.number = gutschrift.number.replace(/^RE/, 'GS');
  await store.saveInvoices();

  // Firebase update
  if (store.useFirebase) {
    try { await db.collection('invoices').doc(gutschrift.id).set(gutschrift); } catch (e) {}
  }

  renderDashboard();
  showToast('Gutschrift ' + gutschrift.number + ' erstellt', 'success');
}

// ==========================
// INVOICES
// ==========================
function updateInvoiceForm() {
  const settings = store.settings;
  if (!settings) return;

  const taxLabel = settings.taxMode === 'kleinunternehmer'
    ? 'Kleinunternehmer (§19 UStG)' : 'Regelbesteuerung';
  document.getElementById('current-tax-mode').textContent = taxLabel;

  const mwstRow = document.getElementById('mwst-row');
  if (mwstRow) mwstRow.style.display = settings.taxMode === 'kleinunternehmer' ? 'none' : '';

  const select = document.getElementById('invoice-customer');
  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Kunde --</option>';
  store.customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  });
  select.value = currentVal;

  if (!document.getElementById('invoice-date').value) {
    document.getElementById('invoice-date').value = new Date().toISOString().split('T')[0];
  }

  if (currentInvoiceItems.length === 0) addInvoiceItem();
  else renderInvoiceItems();
}

function addInvoiceItem() {
  currentInvoiceItems.push({ description: '', quantity: 1, unit: 'Stk.', price: 0, taxRate: 19 });
  renderInvoiceItems();
}

function removeInvoiceItem(index) {
  currentInvoiceItems.splice(index, 1);
  if (currentInvoiceItems.length === 0) addInvoiceItem();
  else { renderInvoiceItems(); recalculateInvoice(); }
}

function renderInvoiceItems() {
  const container = document.getElementById('items-cards');
  const isKlein = store.settings && store.settings.taxMode === 'kleinunternehmer';

  container.innerHTML = currentInvoiceItems.map((item, i) => {
    const total = item.quantity * item.price;
    return `<div class="item-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong style="font-size:12px;color:var(--text-secondary);">Position ${i + 1}</strong>
        <button type="button" class="btn-icon" onclick="removeInvoiceItem(${i})">&times;</button>
      </div>
      <div class="form-group">
        <input type="text" value="${escapeHtml(item.description)}" placeholder="Beschreibung" onchange="updateItem(${i},'description',this.value)">
      </div>
      <div class="form-row">
        <div class="form-group">
          <input type="number" value="${item.quantity}" step="any" placeholder="Menge" onchange="updateItem(${i},'quantity',parseFloat(this.value)||0)">
        </div>
        <div class="form-group" style="flex:0.6">
          <input type="text" value="${escapeHtml(item.unit)}" onchange="updateItem(${i},'unit',this.value)">
        </div>
        <div class="form-group">
          <input type="number" value="${item.price}" step="any" placeholder="Preis" onchange="updateItem(${i},'price',parseFloat(this.value)||0)">
        </div>
      </div>
      ${!isKlein ? `<div class="form-group">
        <select onchange="updateItem(${i},'taxRate',parseInt(this.value))">
          <option value="19" ${item.taxRate===19?'selected':''}>19% MwSt</option>
          <option value="7" ${item.taxRate===7?'selected':''}>7% MwSt</option>
          <option value="0" ${item.taxRate===0?'selected':''}>0%</option>
        </select>
      </div>` : ''}
      <div style="text-align:right;font-weight:600;font-size:14px;">${formatCurrency(total)}</div>
    </div>`;
  }).join('');
}

function updateItem(index, field, value) {
  currentInvoiceItems[index][field] = value;
  recalculateInvoice();
  if (field === 'quantity' || field === 'price') {
    renderInvoiceItems();
  }
}

function recalculateInvoice() {
  const settings = store.settings;
  let netto = 0, mwst = 0;
  for (const item of currentInvoiceItems) {
    const n = item.quantity * item.price;
    netto += n;
    if (settings && settings.taxMode === 'regelbesteuerung') mwst += n * ((item.taxRate || 19) / 100);
  }
  netto = Math.round(netto * 100) / 100;
  mwst = Math.round(mwst * 100) / 100;
  document.getElementById('total-netto').textContent = formatCurrency(netto);
  document.getElementById('total-mwst').textContent = formatCurrency(mwst);
  document.getElementById('total-brutto').textContent = formatCurrency(Math.round((netto + mwst) * 100) / 100);
}

function resetInvoiceForm() {
  editingInvoiceId = null;
  document.getElementById('invoice-edit-id').value = '';
  document.getElementById('invoice-form-title').textContent = 'Neue Rechnung';
  document.getElementById('invoice-customer').value = '';
  document.getElementById('invoice-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('invoice-due-days').value = '14';
  document.getElementById('invoice-payment-method').value = 'ueberweisung';
  document.getElementById('invoice-notes').value = '';
  currentInvoiceItems = [];
  addInvoiceItem();
  recalculateInvoice();
}

function collectInvoiceData() {
  return {
    customerId: document.getElementById('invoice-customer').value,
    date: document.getElementById('invoice-date').value,
    dueDays: parseInt(document.getElementById('invoice-due-days').value) || 14,
    paymentMethod: document.getElementById('invoice-payment-method').value,
    notes: document.getElementById('invoice-notes').value,
    items: currentInvoiceItems.filter(i => i.description.trim() !== ''),
    taxMode: store.settings.taxMode,
  };
}

async function saveInvoice() {
  const data = collectInvoiceData();
  if (!data.customerId) { showToast('Bitte Kunden auswaehlen', 'error'); return; }
  if (data.items.length === 0) { showToast('Bitte Position hinzufuegen', 'error'); return; }

  let invoice;
  if (editingInvoiceId) {
    invoice = await store.updateInvoice(editingInvoiceId, data);
    showToast('Rechnung aktualisiert', 'success');
  } else {
    invoice = await store.addInvoice(data);
    showToast('Rechnung ' + invoice.number + ' erstellt', 'success');
  }
  resetInvoiceForm();
  renderDashboard();
}

async function saveInvoiceAndPDF() {
  const data = collectInvoiceData();
  if (!data.customerId) { showToast('Bitte Kunden auswaehlen', 'error'); return; }
  if (data.items.length === 0) { showToast('Bitte Position hinzufuegen', 'error'); return; }

  let invoice;
  if (editingInvoiceId) {
    invoice = await store.updateInvoice(editingInvoiceId, data);
  } else {
    invoice = await store.addInvoice(data);
  }

  await exportInvoicePDF(invoice.id);
  resetInvoiceForm();
  renderDashboard();
}

async function exportInvoicePDF(invoiceId) {
  const inv = store.getInvoice(invoiceId);
  if (!inv) return;

  const settings = store.settings;
  const customer = store.getCustomer(inv.customerId);
  const totals = store.calculateInvoiceTotal(inv);

  try {
    const pdfBytes = await generateInvoicePDF({
      invoice: inv, settings, customer, totals, logoData: null,
    });

    // PDF als Download anbieten
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (inv.number || 'Rechnung') + '.pdf';
    a.click();
    URL.revokeObjectURL(url);
    showToast('PDF heruntergeladen', 'success');
  } catch (err) {
    console.error('PDF-Fehler:', err);
    showToast('PDF-Fehler: ' + err.message, 'error');
  }
}

// ==========================
// CUSTOMERS
// ==========================
function renderCustomersList() {
  const list = document.getElementById('customers-list');
  const empty = document.getElementById('customers-empty');

  if (store.customers.length === 0) {
    if (list) list.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }

  if (list) list.style.display = '';
  if (empty) empty.style.display = 'none';

  list.innerHTML = store.customers.map(c => `
    <div class="card-item">
      <div class="card-item-header">
        <strong>${escapeHtml(c.name)}</strong>
      </div>
      <div class="card-item-body">
        ${escapeHtml(c.street || '')} ${escapeHtml(c.zip || '')} ${escapeHtml(c.city || '')}
        ${c.email ? '<br>' + escapeHtml(c.email) : ''}
      </div>
      <div class="card-item-actions">
        <button class="btn-icon" onclick="editCustomer('${c.id}')">&#9998;</button>
        <button class="btn-icon" onclick="deleteCustomer('${c.id}')">&#128465;</button>
      </div>
    </div>
  `).join('');
}

function showCustomerForm(customer = null) {
  const modal = document.getElementById('customer-modal');
  const title = document.getElementById('customer-modal-title');
  if (customer) {
    title.textContent = 'Kunde bearbeiten';
    document.getElementById('customer-edit-id').value = customer.id;
    document.getElementById('customer-name').value = customer.name || '';
    document.getElementById('customer-street').value = customer.street || '';
    document.getElementById('customer-zip').value = customer.zip || '';
    document.getElementById('customer-city').value = customer.city || '';
    document.getElementById('customer-email').value = customer.email || '';
    document.getElementById('customer-phone').value = customer.phone || '';
  } else {
    title.textContent = 'Neuer Kunde';
    document.getElementById('customer-edit-id').value = '';
    document.getElementById('customer-form').reset();
  }
  modal.classList.add('active');
}

function closeCustomerModal() { document.getElementById('customer-modal').classList.remove('active'); }

function editCustomer(id) {
  const c = store.getCustomer(id);
  if (c) showCustomerForm(c);
}

async function deleteCustomer(id) {
  if (!confirm('Kunden loeschen?')) return;
  await store.deleteCustomer(id);
  renderCustomersList();
  showToast('Kunde geloescht');
}

async function saveCustomer() {
  const editId = document.getElementById('customer-edit-id').value;
  const data = {
    name: document.getElementById('customer-name').value.trim(),
    street: document.getElementById('customer-street').value.trim(),
    zip: document.getElementById('customer-zip').value.trim(),
    city: document.getElementById('customer-city').value.trim(),
    email: document.getElementById('customer-email').value.trim(),
    phone: document.getElementById('customer-phone').value.trim(),
  };
  if (!data.name) { showToast('Bitte Name eingeben', 'error'); return; }

  if (editId) {
    await store.updateCustomer(editId, data);
    showToast('Kunde aktualisiert', 'success');
  } else {
    await store.addCustomer(data);
    showToast('Kunde angelegt', 'success');
  }
  closeCustomerModal();
  renderCustomersList();
  updateInvoiceForm();
}

// Setup form submit
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('customer-form').addEventListener('submit', e => {
    e.preventDefault();
    saveCustomer();
  });
  document.getElementById('settings-form').addEventListener('submit', e => {
    e.preventDefault();
    saveSettingsForm();
  });
  document.getElementById('settings-invoice-prefix').addEventListener('input', updateNumberPreview);
  document.getElementById('settings-next-number').addEventListener('input', updateNumberPreview);
});

// ==========================
// SETTINGS
// ==========================
async function renderSettingsForm() {
  const s = store.settings;
  if (!s) return;
  document.getElementById('settings-company-name').value = s.company.name || '';
  document.getElementById('settings-address').value = s.company.address || '';
  document.getElementById('settings-zip').value = s.company.zip || '';
  document.getElementById('settings-city').value = s.company.city || '';
  document.getElementById('settings-phone').value = s.company.phone || '';
  document.getElementById('settings-email').value = s.company.email || '';
  document.getElementById('settings-website').value = s.company.website || '';
  document.getElementById('settings-tax-number').value = s.company.taxNumber || '';
  document.getElementById('settings-vat-id').value = s.company.vatId || '';
  document.getElementById('settings-tax-mode').value = s.taxMode || 'kleinunternehmer';
  document.getElementById('settings-bank-name').value = s.company.bankName || '';
  document.getElementById('settings-iban').value = s.company.iban || '';
  document.getElementById('settings-bic').value = s.company.bic || '';
  document.getElementById('settings-invoice-prefix').value = s.invoicePrefix || 'RE';
  document.getElementById('settings-next-number').value = s.nextInvoiceNumber || 1;
  updateNumberPreview();
}

function updateNumberPreview() {
  const prefix = document.getElementById('settings-invoice-prefix').value || 'RE';
  const num = document.getElementById('settings-next-number').value || '1';
  document.getElementById('settings-number-preview').value = prefix + '-' + new Date().getFullYear() + '-' + String(num).padStart(3, '0');
}

async function saveSettingsForm() {
  const settings = {
    company: {
      name: document.getElementById('settings-company-name').value.trim(),
      address: document.getElementById('settings-address').value.trim(),
      zip: document.getElementById('settings-zip').value.trim(),
      city: document.getElementById('settings-city').value.trim(),
      phone: document.getElementById('settings-phone').value.trim(),
      email: document.getElementById('settings-email').value.trim(),
      website: document.getElementById('settings-website').value.trim(),
      taxNumber: document.getElementById('settings-tax-number').value.trim(),
      vatId: document.getElementById('settings-vat-id').value.trim(),
      bankName: document.getElementById('settings-bank-name').value.trim(),
      iban: document.getElementById('settings-iban').value.trim(),
      bic: document.getElementById('settings-bic').value.trim(),
    },
    taxMode: document.getElementById('settings-tax-mode').value,
    invoicePrefix: document.getElementById('settings-invoice-prefix').value.trim() || 'RE',
    nextInvoiceNumber: parseInt(document.getElementById('settings-next-number').value) || 1,
    logoPath: store.settings.logoPath || '',
  };
  await store.saveSettings(settings);
  showToast('Einstellungen gespeichert', 'success');
  updateInvoiceForm();
}

// ==========================
// SAVED ITEMS
// ==========================
function showSavedItemsPicker() {
  const picker = document.getElementById('saved-items-picker');
  if (savedItems.length === 0) {
    showToast('Keine gespeicherten Positionen', 'error');
    return;
  }
  if (picker.style.display === 'none') {
    picker.style.display = 'flex';
    picker.innerHTML = savedItems.map((item, i) => `
      <div class="saved-item-chip" onclick="insertSavedItem(${i})">
        ${escapeHtml(item.description)}
      </div>
    `).join('');
  } else {
    picker.style.display = 'none';
  }
}

function insertSavedItem(index) {
  const item = savedItems[index];
  if (!item) return;
  currentInvoiceItems.push({ ...item });
  renderInvoiceItems();
  recalculateInvoice();
  showToast('"' + item.description + '" eingefuegt', 'success');
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
