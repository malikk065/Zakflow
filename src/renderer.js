// --- App State ---
let currentInvoiceItems = [];
let editingInvoiceId = null;
let savedItems = [];
let darkMode = false;

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // Plattform-Klasse setzen für CSS
  document.body.parentElement.classList.add(`platform-${navigator.platform.includes('Mac') ? 'darwin' : 'win32'}`);

  // Dark Mode laden
  darkMode = await window.api.getDarkMode();
  applyDarkMode();

  // Firebase Config laden und verbinden
  const fbConfig = await window.api.getFirebaseConfig();
  if (fbConfig) {
    const ok = initFirebase(fbConfig);
    if (ok) store.useFirebase = true;
  }

  // Passwortschutz prüfen
  const hasPassword = await window.api.getPasswordHash();
  if (hasPassword) {
    document.getElementById('password-overlay').style.display = 'flex';
    document.getElementById('password-input').focus();
    return;
  }

  await initApp();
});

async function initApp() {
  await store.loadSettings();
  await store.loadCustomers();
  await store.loadInvoices();
  savedItems = await window.api.getSavedItems() || [];

  // Lokale Daten nach Firebase synchronisieren
  await syncToFirebase();

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

  setupNavigation();
  setupForms();
  renderDashboard();
  renderCustomersList();
  renderSettingsForm();
  updateInvoiceForm();
  updateNumberPreview();
  updatePasswordStatus();
}

async function syncToFirebase() {
  if (typeof db === 'undefined') return;

  try {
    // Settings hochladen
    if (store.settings && store.settings.company && store.settings.company.name) {
      await db.collection('app').doc('settings').set(store.settings);
    }

    // Kunden hochladen (nur wenn Firebase leer ist oder weniger Daten hat)
    const fbCustomers = await db.collection('customers').get();
    if (fbCustomers.empty && store.customers.length > 0) {
      console.log('Sync: Lade', store.customers.length, 'Kunden nach Firebase hoch...');
      const batch = db.batch();
      for (const c of store.customers) {
        batch.set(db.collection('customers').doc(c.id), c);
      }
      await batch.commit();
    } else if (!fbCustomers.empty && store.customers.length === 0) {
      // Firebase hat Daten, lokal leer → von Firebase laden
      store.customers = fbCustomers.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (window.api) await window.api.saveCustomers(store.customers);
    }

    // Rechnungen hochladen
    const fbInvoices = await db.collection('invoices').get();
    if (fbInvoices.empty && store.invoices.length > 0) {
      console.log('Sync: Lade', store.invoices.length, 'Rechnungen nach Firebase hoch...');
      // Firestore batch limit ist 500, also aufteilen
      for (let i = 0; i < store.invoices.length; i += 400) {
        const batch = db.batch();
        const chunk = store.invoices.slice(i, i + 400);
        for (const inv of chunk) {
          batch.set(db.collection('invoices').doc(inv.id), inv);
        }
        await batch.commit();
      }
    } else if (!fbInvoices.empty && store.invoices.length === 0) {
      store.invoices = fbInvoices.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (window.api) await window.api.saveInvoices(store.invoices);
    }

    // Saved Items hochladen
    if (savedItems.length > 0) {
      await db.collection('app').doc('savedItems').set({ items: savedItems });
    }

    // Passwort synchronisieren
    if (window.api) {
      const localHash = await window.api.getPasswordHash();
      if (localHash) {
        await db.collection('app').doc('auth').set({ hash: localHash });
      }
    }

    console.log('Firebase Sync abgeschlossen');
  } catch (e) {
    console.warn('Firebase Sync Fehler:', e);
  }
}

// --- Navigation ---
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tabName) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));

  const navItem = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
  const tabContent = document.getElementById(`tab-${tabName}`);

  if (navItem) navItem.classList.add('active');
  if (tabContent) tabContent.classList.add('active');

  // Refresh data when switching tabs
  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'customers') renderCustomersList();
  if (tabName === 'new-invoice') updateInvoiceForm();
}

// --- Toast ---
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast show ' + type;
  setTimeout(() => {
    toast.className = 'toast';
  }, 3000);
}

// --- Format helpers ---
function formatCurrency(amount) {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('de-DE');
}

// ==========================
// DASHBOARD
// ==========================
function renderDashboard() {
  const invoices = store.invoices;
  const total = invoices.length;
  const open = invoices.filter((i) => i.status === 'offen').length;
  const paid = invoices.filter((i) => i.status === 'bezahlt').length;

  let revenue = 0;
  invoices
    .filter((i) => i.status === 'bezahlt')
    .forEach((i) => {
      const totals = store.calculateInvoiceTotal(i);
      revenue += totals.brutto;
    });

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-open').textContent = open;
  document.getElementById('stat-paid').textContent = paid;
  document.getElementById('stat-revenue').textContent = formatCurrency(revenue);

  const tbody = document.getElementById('invoices-tbody');
  const empty = document.getElementById('dashboard-empty');
  const table = document.getElementById('invoices-table');

  if (invoices.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  // Sort by date descending
  const sorted = [...invoices].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  tbody.innerHTML = sorted
    .map((inv) => {
      const totals = store.calculateInvoiceTotal(inv);
      const customer = store.getCustomer(inv.customerId);
      const statusClass =
        inv.status === 'bezahlt'
          ? 'badge-paid'
          : inv.status === 'storniert'
          ? 'badge-cancelled'
          : 'badge-open';

      const isGutschrift = inv.type === 'gutschrift';
      return `<tr>
      <td><strong>${inv.number}</strong></td>
      <td>${formatDate(inv.date)}</td>
      <td>${customer ? customer.name : 'Unbekannt'}</td>
      <td>${isGutschrift ? '-' : ''}${formatCurrency(totals.brutto)}</td>
      <td><span class="badge ${isGutschrift ? 'badge-credit' : statusClass}">${isGutschrift ? 'Gutschrift' : inv.status}</span></td>
      <td>
        <button class="btn-icon" title="PDF exportieren" onclick="exportInvoicePDF('${inv.id}')">&#128196;</button>
        <button class="btn-icon" title="Bearbeiten" onclick="editInvoice('${inv.id}')">&#9998;</button>
        <button class="btn-icon" title="Status ändern" onclick="toggleInvoiceStatus('${inv.id}')">&#10003;</button>
        ${!isGutschrift ? `<button class="btn-icon" title="Gutschrift erstellen" onclick="createGutschrift('${inv.id}')">↩</button>` : ''}
        <button class="btn-icon" title="Löschen" onclick="deleteInvoice('${inv.id}')">&#128465;</button>
      </td>
    </tr>`;
    })
    .join('');
}

async function toggleInvoiceStatus(id) {
  const inv = store.getInvoice(id);
  if (!inv) return;
  const newStatus = inv.status === 'offen' ? 'bezahlt' : 'offen';
  await store.updateInvoice(id, { status: newStatus });
  renderDashboard();
  showToast(`Rechnung als "${newStatus}" markiert`, 'success');
}

async function deleteInvoice(id) {
  if (!confirm('Rechnung wirklich löschen?')) return;
  await store.deleteInvoice(id);
  renderDashboard();
  showToast('Rechnung gelöscht');
}

function editInvoice(id) {
  const inv = store.getInvoice(id);
  if (!inv) return;

  editingInvoiceId = id;
  document.getElementById('invoice-edit-id').value = id;
  document.getElementById('invoice-form-title').textContent = `Rechnung ${inv.number} bearbeiten`;
  document.getElementById('invoice-customer').value = inv.customerId || '';
  document.getElementById('invoice-date').value = inv.date || '';
  document.getElementById('invoice-due-days').value = inv.dueDays || 14;
  document.getElementById('invoice-notes').value = inv.notes || '';
  document.getElementById('invoice-payment-method').value = inv.paymentMethod || 'ueberweisung';

  currentInvoiceItems = JSON.parse(JSON.stringify(inv.items || []));
  renderInvoiceItems();
  recalculateInvoice();

  switchTab('new-invoice');
}

// ==========================
// INVOICES
// ==========================
function updateInvoiceForm() {
  const settings = store.settings;
  if (!settings) return;

  // Tax mode display
  const taxLabel =
    settings.taxMode === 'kleinunternehmer'
      ? 'Kleinunternehmer (§19 UStG) - keine MwSt'
      : 'Regelbesteuerung - MwSt wird ausgewiesen';
  document.getElementById('current-tax-mode').textContent = taxLabel;

  // Show/hide tax columns
  const taxCols = document.querySelectorAll('.tax-col');
  const mwstRow = document.getElementById('mwst-row');
  if (settings.taxMode === 'kleinunternehmer') {
    taxCols.forEach((c) => (c.style.display = 'none'));
    if (mwstRow) mwstRow.style.display = 'none';
  } else {
    taxCols.forEach((c) => (c.style.display = ''));
    if (mwstRow) mwstRow.style.display = '';
  }

  // Populate customer dropdown
  const select = document.getElementById('invoice-customer');
  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Kunde auswählen --</option>';
  store.customers.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  });
  select.value = currentVal;

  // Set default date
  if (!document.getElementById('invoice-date').value) {
    document.getElementById('invoice-date').value = new Date()
      .toISOString()
      .split('T')[0];
  }

  // Add initial item if empty
  if (currentInvoiceItems.length === 0) {
    addInvoiceItem();
  } else {
    renderInvoiceItems();
  }
}

function addInvoiceItem() {
  currentInvoiceItems.push({
    description: '',
    quantity: 1,
    unit: 'Stk.',
    price: 0,
    taxRate: 19,
  });
  renderInvoiceItems();
}

function removeInvoiceItem(index) {
  currentInvoiceItems.splice(index, 1);
  if (currentInvoiceItems.length === 0) addInvoiceItem();
  else {
    renderInvoiceItems();
    recalculateInvoice();
  }
}

function renderInvoiceItems() {
  const tbody = document.getElementById('items-tbody');
  const settings = store.settings;
  const isKlein = settings && settings.taxMode === 'kleinunternehmer';

  tbody.innerHTML = currentInvoiceItems
    .map((item, i) => {
      const total = item.quantity * item.price;
      return `<tr>
      <td>${i + 1}</td>
      <td><input type="text" value="${escapeHtml(item.description)}" onchange="updateItem(${i},'description',this.value)" placeholder="Beschreibung"></td>
      <td><input type="number" value="${item.quantity}" step="any" onchange="updateItem(${i},'quantity',parseFloat(this.value)||0)"></td>
      <td><input type="text" value="${escapeHtml(item.unit)}" onchange="updateItem(${i},'unit',this.value)" style="width:70px"></td>
      <td><input type="number" value="${item.price}" step="any" onchange="updateItem(${i},'price',parseFloat(this.value)||0)"></td>
      <td class="tax-col" ${isKlein ? 'style="display:none"' : ''}>
        <select onchange="updateItem(${i},'taxRate',parseInt(this.value))">
          <option value="19" ${item.taxRate === 19 ? 'selected' : ''}>19%</option>
          <option value="7" ${item.taxRate === 7 ? 'selected' : ''}>7%</option>
          <option value="0" ${item.taxRate === 0 ? 'selected' : ''}>0%</option>
        </select>
      </td>
      <td class="item-total"><input type="text" value="${formatCurrency(total)}" readonly tabindex="-1" style="text-align:right;background:transparent;border:none;font-weight:500;cursor:default;width:100%;"></td>
      <td><button type="button" class="btn-icon" onclick="removeInvoiceItem(${i})" title="Entfernen">&times;</button></td>
    </tr>`;
    })
    .join('');
}

function updateItem(index, field, value) {
  currentInvoiceItems[index][field] = value;
  recalculateInvoice();
  // Nur Gesamtpreis dieser Zeile aktualisieren - kein kompletter DOM-Neubau
  if (field === 'quantity' || field === 'price') {
    const total = currentInvoiceItems[index].quantity * currentInvoiceItems[index].price;
    const rows = document.querySelectorAll('#items-tbody tr');
    if (rows[index]) {
      const totalInput = rows[index].querySelector('.item-total input');
      if (totalInput) totalInput.value = formatCurrency(total);
    }
  } else if (field === 'taxRate') {
    // Steuerrate geändert - nur Gesamtsummen neu berechnen, kein DOM-Neubau nötig
  }
}

function recalculateInvoice() {
  const settings = store.settings;
  let netto = 0;
  let mwst = 0;

  for (const item of currentInvoiceItems) {
    const itemNetto = item.quantity * item.price;
    netto += itemNetto;
    if (settings && settings.taxMode === 'regelbesteuerung') {
      mwst += itemNetto * ((item.taxRate || 19) / 100);
    }
  }

  netto = Math.round(netto * 100) / 100;
  mwst = Math.round(mwst * 100) / 100;
  const brutto = Math.round((netto + mwst) * 100) / 100;

  document.getElementById('total-netto').textContent = formatCurrency(netto);
  document.getElementById('total-mwst').textContent = formatCurrency(mwst);
  document.getElementById('total-brutto').textContent = formatCurrency(brutto);
}

function resetInvoiceForm() {
  editingInvoiceId = null;
  document.getElementById('invoice-edit-id').value = '';
  document.getElementById('invoice-form-title').textContent = 'Neue Rechnung';
  document.getElementById('invoice-customer').value = '';
  document.getElementById('invoice-date').value = new Date()
    .toISOString()
    .split('T')[0];
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
    items: currentInvoiceItems.filter((item) => item.description.trim() !== ''),
    taxMode: store.settings.taxMode,
  };
}

function setupForms() {
  // Invoice: kein <form> mehr - Buttons haben direkte onclick-Handler

  // Customer form
  document.getElementById('customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveCustomer();
  });

  // Settings form
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettingsForm();
  });

  // Number preview update
  document.getElementById('settings-invoice-prefix').addEventListener('input', updateNumberPreview);
  document.getElementById('settings-next-number').addEventListener('input', updateNumberPreview);
}

async function saveInvoice() {
  const data = collectInvoiceData();

  if (!data.customerId) {
    showToast('Bitte einen Kunden auswählen', 'error');
    return null;
  }

  if (data.items.length === 0) {
    showToast('Bitte mindestens eine Position hinzufügen', 'error');
    return null;
  }

  let invoice;
  if (editingInvoiceId) {
    invoice = await store.updateInvoice(editingInvoiceId, data);
    showToast('Rechnung aktualisiert', 'success');
  } else {
    invoice = await store.addInvoice(data);
    showToast(`Rechnung ${invoice.number} erstellt`, 'success');
  }

  // Automatisch als PDF in OneDrive speichern (kein Dialog)
  await exportInvoicePDF(invoice.id, true);

  resetInvoiceForm();
  renderDashboard();
  return invoice;
}

async function saveInvoiceAndPDF() {
  const data = collectInvoiceData();

  if (!data.customerId) {
    showToast('Bitte einen Kunden auswählen', 'error');
    return;
  }
  if (data.items.length === 0 || data.items.every(i => !i.description.trim())) {
    showToast('Bitte mindestens eine Position hinzufügen', 'error');
    return;
  }

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

async function exportInvoicePDF(invoiceId, skipDialog = false) {
  const inv = store.getInvoice(invoiceId);
  if (!inv) return;

  const settings = await store.loadSettings();
  const customer = store.getCustomer(inv.customerId);
  const totals = store.calculateInvoiceTotal(inv);

  // Logo laden
  let logoData = null;
  const logoPath = await window.api.getLogo();
  if (logoPath) {
    logoData = await window.api.readLogoBase64(logoPath);
  }

  try {
    const pdfBytes = await generateInvoicePDF({
      invoice: inv,
      settings,
      customer,
      totals,
      logoData,
    });

    // Immer automatisch in OneDrive/Daten-Ordner speichern
    const autoPath = await window.api.saveAutoPDF(pdfBytes, inv.number);

    if (!skipDialog) {
      // Zusätzlich Speichern-Dialog für manuelles Speichern
      const savedPath = await window.api.savePDF(pdfBytes, inv.number);
      if (savedPath) {
        showToast(`PDF gespeichert: ${savedPath.split('/').pop()}`, 'success');
      } else {
        showToast(`PDF gespeichert in OneDrive: ${inv.number}.pdf`, 'success');
      }
    } else {
      showToast(`PDF gespeichert in OneDrive: ${inv.number}.pdf`, 'success');
    }

    return autoPath;
  } catch (err) {
    console.error('PDF-Fehler:', err);
    showToast('Fehler beim PDF-Export: ' + err.message, 'error');
  }
}

// ==========================
// CUSTOMERS
// ==========================
function renderCustomersList() {
  const tbody = document.getElementById('customers-tbody');
  const empty = document.getElementById('customers-empty');
  const table = document.getElementById('customers-table');

  if (store.customers.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  tbody.innerHTML = store.customers
    .map(
      (c) => `<tr>
      <td><strong>${escapeHtml(c.name)}</strong></td>
      <td>${escapeHtml(c.street || '')} ${escapeHtml(c.zip || '')} ${escapeHtml(c.city || '')}</td>
      <td>${escapeHtml(c.email || '')}</td>
      <td>
        <button class="btn-icon" onclick="editCustomer('${c.id}')" title="Bearbeiten">&#9998;</button>
        <button class="btn-icon" onclick="deleteCustomer('${c.id}')" title="Löschen">&#128465;</button>
      </td>
    </tr>`
    )
    .join('');
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

function closeCustomerModal() {
  document.getElementById('customer-modal').classList.remove('active');
}

function editCustomer(id) {
  const customer = store.getCustomer(id);
  if (customer) showCustomerForm(customer);
}

async function deleteCustomer(id) {
  if (!confirm('Kunden wirklich löschen?')) return;
  store.deleteCustomer(id);
  renderCustomersList();
  showToast('Kunde gelöscht');
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

  if (!data.name) {
    showToast('Bitte einen Namen eingeben', 'error');
    return;
  }

  if (editId) {
    store.updateCustomer(editId, data);
    showToast('Kunde aktualisiert', 'success');
  } else {
    store.addCustomer(data);
    showToast('Kunde angelegt', 'success');
  }

  closeCustomerModal();
  renderCustomersList();
  updateInvoiceForm();
}

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

  // Data path
  const dataPath = await window.api.getDataPath();
  document.getElementById('settings-data-path').value = dataPath;

  // Logo
  await renderLogoPreview();
  updateNumberPreview();
  renderSavedItemsList();
  updatePasswordStatus();
  renderFirebaseStatus();
}

async function renderLogoPreview() {
  const preview = document.getElementById('logo-preview');
  const logoPath = await window.api.getLogo();
  if (logoPath) {
    const logoData = await window.api.readLogoBase64(logoPath);
    if (logoData) {
      preview.innerHTML = `<img src="data:${logoData.mimeType};base64,${logoData.data}" alt="Logo">`;
      return;
    }
  }
  preview.innerHTML = '<span class="logo-placeholder">Kein Logo</span>';
}

async function uploadLogo() {
  console.log('uploadLogo aufgerufen');
  try {
    const result = await window.api.uploadLogo();
    console.log('uploadLogo Ergebnis:', result);
    if (result) {
      store.settings.logoPath = result;
      await store.saveSettings(store.settings);
      showToast('Logo hochgeladen', 'success');
      await renderLogoPreview();
    } else {
      console.log('Upload abgebrochen oder fehlgeschlagen');
    }
  } catch (err) {
    console.error('uploadLogo Fehler:', err);
    showToast('Logo-Fehler: ' + err.message, 'error');
  }
}

async function chooseDataPath() {
  const newPath = await window.api.chooseDataPath();
  if (newPath) {
    document.getElementById('settings-data-path').value = newPath;
    showToast('Daten-Ordner geändert. Bitte App neu starten.', 'success');
  }
}

function updateNumberPreview() {
  const prefix = document.getElementById('settings-invoice-prefix').value || 'RE';
  const num = document.getElementById('settings-next-number').value || '1';
  const year = new Date().getFullYear();
  document.getElementById('settings-number-preview').value =
    `${prefix}-${year}-${String(num).padStart(3, '0')}`;
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
// PASSWORD
// ==========================
async function simpleHash(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkPassword() {
  const input = document.getElementById('password-input').value;
  const storedHash = await window.api.getPasswordHash();
  const inputHash = await simpleHash(input);

  if (inputHash === storedHash) {
    document.getElementById('password-overlay').style.display = 'none';
    await initApp();
  } else {
    document.getElementById('password-error').style.display = 'block';
    document.getElementById('password-input').value = '';
    document.getElementById('password-input').focus();
  }
}

async function setAppPassword() {
  const pw = document.getElementById('settings-password').value.trim();
  if (!pw) {
    showToast('Bitte ein Passwort eingeben', 'error');
    return;
  }
  const hash = await simpleHash(pw);
  await window.api.setPasswordHash(hash);
  document.getElementById('settings-password').value = '';
  updatePasswordStatus();
  showToast('Passwort gesetzt', 'success');
}

async function removeAppPassword() {
  await window.api.setPasswordHash(null);
  updatePasswordStatus();
  showToast('Passwort entfernt', 'success');
}

async function updatePasswordStatus() {
  const hash = await window.api.getPasswordHash();
  const label = document.getElementById('password-status-label');
  if (label) {
    label.textContent = hash ? 'Passwort: ✅ aktiv' : 'Passwort: nicht gesetzt';
  }
}

// ==========================
// DARK MODE
// ==========================
function applyDarkMode() {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  const icon = document.getElementById('dark-mode-icon');
  const label = document.getElementById('dark-mode-label');
  if (icon) icon.textContent = darkMode ? '☀️' : '🌙';
  if (label) label.textContent = darkMode ? 'Hellmodus' : 'Dunkelmodus';
}

async function toggleDarkMode() {
  darkMode = !darkMode;
  applyDarkMode();
  await window.api.setDarkMode(darkMode);
}

// ==========================
// SEARCH / FILTER
// ==========================
function filterInvoices() {
  const query = document.getElementById('search-invoices').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#invoices-tbody tr');

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
}

function filterCustomers() {
  const query = document.getElementById('search-customers').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#customers-tbody tr');

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
}

// ==========================
// GUTSCHRIFT
// ==========================
async function createGutschrift(invoiceId) {
  const inv = store.getInvoice(invoiceId);
  if (!inv) return;

  if (!confirm(`Gutschrift für Rechnung ${inv.number} erstellen?`)) return;

  const gutschriftData = {
    customerId: inv.customerId,
    date: new Date().toISOString().split('T')[0],
    dueDays: 0,
    paymentMethod: inv.paymentMethod || 'ueberweisung',
    notes: `Gutschrift zu Rechnung ${inv.number}`,
    items: inv.items.map(item => ({ ...item })),
    taxMode: inv.taxMode || store.settings.taxMode,
    type: 'gutschrift',
    relatedInvoice: inv.number,
  };

  const gutschrift = await store.addInvoice(gutschriftData);
  // Type muss nach addInvoice gesetzt werden (addInvoice setzt status auf 'offen')
  gutschrift.type = 'gutschrift';
  gutschrift.status = 'gutschrift';
  // Nummer anpassen: GS statt RE
  gutschrift.number = gutschrift.number.replace(/^RE/, 'GS');
  await store.saveInvoices();

  // PDF automatisch erstellen
  await exportInvoicePDF(gutschrift.id, true);

  renderDashboard();
  showToast(`Gutschrift ${gutschrift.number} erstellt`, 'success');
}

// ==========================
// SAVED ITEMS (Gespeicherte Positionen)
// ==========================
function renderSavedItemsList() {
  const container = document.getElementById('saved-items-list');
  if (!container) return;

  if (savedItems.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">Noch keine Positionen gespeichert.</p>';
    return;
  }

  container.innerHTML = savedItems.map((item, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-light);">
      <span style="flex:1;font-size:13px;"><strong>${escapeHtml(item.description)}</strong> — ${item.quantity} ${escapeHtml(item.unit)} × ${formatCurrency(item.price)}</span>
      <button type="button" class="btn-icon" onclick="removeSavedItem(${i})" title="Entfernen">✕</button>
    </div>
  `).join('');
}

async function addSavedItem() {
  // Letzte Position aus dem aktuellen Rechnungsformular speichern
  const lastItem = currentInvoiceItems.filter(i => i.description.trim()).pop();
  if (!lastItem) {
    // Leeres Item hinzufügen
    const desc = prompt('Beschreibung der Position:');
    if (!desc) return;
    const price = parseFloat(prompt('Einzelpreis (€):', '0') || '0');
    const unit = prompt('Einheit:', 'Stk.') || 'Stk.';
    savedItems.push({
      description: desc,
      quantity: 1,
      unit: unit,
      price: price,
      taxRate: 19,
    });
  } else {
    savedItems.push({ ...lastItem });
  }

  await window.api.saveSavedItems(savedItems);
  renderSavedItemsList();
  showToast('Position gespeichert', 'success');
}

async function removeSavedItem(index) {
  savedItems.splice(index, 1);
  await window.api.saveSavedItems(savedItems);
  renderSavedItemsList();
}

function showSavedItemsPicker() {
  const picker = document.getElementById('saved-items-picker');
  if (savedItems.length === 0) {
    showToast('Keine gespeicherten Positionen vorhanden. Speichere welche in den Einstellungen.', 'error');
    return;
  }

  if (picker.style.display === 'none') {
    picker.style.display = 'flex';
    picker.innerHTML = savedItems.map((item, i) => `
      <div class="saved-item-chip" onclick="insertSavedItem(${i})" title="${escapeHtml(item.description)} — ${formatCurrency(item.price)}">
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
  showToast(`"${item.description}" hinzugefügt`, 'success');
}

// ==========================
// FIREBASE CONNECT
// ==========================
async function connectFirebase() {
  const input = document.getElementById('firebase-config-input').value.trim();
  if (!input) {
    showToast('Bitte Firebase Config einfügen', 'error');
    return;
  }

  let config;
  try {
    config = JSON.parse(input);
  } catch (e) {
    showToast('Ungültiges JSON Format', 'error');
    return;
  }

  if (!config.apiKey || !config.projectId) {
    showToast('apiKey und projectId fehlen', 'error');
    return;
  }

  const success = initFirebase(config);
  if (success) {
    await window.api.saveFirebaseConfig(config);
    store.useFirebase = true;

    // Lokale Daten nach Firebase hochladen
    await syncToFirebase();

    // Echtzeit-Sync starten
    store.onDataChanged = (type) => {
      if (type === 'customers') { renderCustomersList(); updateInvoiceForm(); }
      if (type === 'invoices') { renderDashboard(); }
      if (type === 'settings') { renderSettingsForm(); updateInvoiceForm(); }
    };
    store.startRealtimeSync();

    showToast('Firebase verbunden! Daten werden synchronisiert.', 'success');
  } else {
    showToast('Firebase Verbindung fehlgeschlagen', 'error');
  }

  renderFirebaseStatus();
}

async function disconnectFirebase() {
  store.stopRealtimeSync();
  store.useFirebase = false;
  firebaseReady = false;
  db = null;

  if (window.api) await window.api.removeFirebaseConfig();

  showToast('Firebase getrennt', 'success');
  renderFirebaseStatus();
}

function renderFirebaseStatus() {
  const el = document.getElementById('firebase-status');
  if (!el) return;

  if (firebaseReady && db) {
    const projectId = firebase.app().options.projectId || 'Unbekannt';
    el.innerHTML = `<span style="color:var(--success);font-weight:600;">✅ Verbunden</span> <span style="color:var(--text-secondary);font-size:12px;">— Projekt: ${projectId}</span>`;
    document.getElementById('firebase-config-input').value = '';
  } else {
    el.innerHTML = '<span style="color:var(--text-secondary);">❌ Nicht verbunden — Daten nur lokal gespeichert</span>';
  }
}

// ==========================
// PDF IMPORT
// ==========================
let pendingImports = [];

function parsePDFText(text, fileName) {
  const result = {
    fileName,
    invoiceNumber: '',
    date: '',
    customerName: '',
    customerStreet: '',
    customerZip: '',
    customerCity: '',
    totalAmount: 0,
    status: 'bezahlt',
    paymentMethod: 'ueberweisung',
  };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Rechnungsnummer suchen
  for (const line of lines) {
    // Typische Muster: RE-2024-001, Rechnungsnummer: XYZ, Rechnung Nr. XYZ, Invoice #XYZ
    const reMatch = line.match(/(?:RE|INV|RG|RN)[-\s]?\d{4}[-\s]?\d{1,5}/i);
    if (reMatch) {
      result.invoiceNumber = reMatch[0].trim();
      break;
    }
    const numMatch = line.match(/(?:Rechnungsnummer|Rechnung\s*(?:Nr\.?|Nummer)|Invoice\s*(?:#|No\.?|Number))[:\s]*([A-Za-z0-9\-\/]+)/i);
    if (numMatch) {
      result.invoiceNumber = numMatch[1].trim();
      break;
    }
  }

  // Datum suchen
  for (const line of lines) {
    // DD.MM.YYYY
    const dateMatch = line.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    if (dateMatch) {
      const parts = dateMatch[1].split('.');
      result.date = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
      break;
    }
    // YYYY-MM-DD
    const isoMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) {
      result.date = isoMatch[1];
      break;
    }
  }

  // Gesamtbetrag suchen
  for (const line of lines) {
    const totalMatch = line.match(/(?:Gesamt|Brutto|Total|Summe|Rechnungsbetrag|Gesamtbetrag)[:\s]*(\d[\d.,]*)\s*€?/i);
    if (totalMatch) {
      result.totalAmount = parseFloat(totalMatch[1].replace(/\./g, '').replace(',', '.')) || 0;
    }
  }
  // Fallback: größten €-Betrag nehmen
  if (result.totalAmount === 0) {
    let maxAmount = 0;
    for (const line of lines) {
      const amounts = line.match(/(\d[\d.,]*)\s*€/g);
      if (amounts) {
        for (const a of amounts) {
          const val = parseFloat(a.replace(/\./g, '').replace(',', '.').replace('€', '').trim()) || 0;
          if (val > maxAmount) maxAmount = val;
        }
      }
    }
    result.totalAmount = maxAmount;
  }

  // Bar bezahlt erkennen
  if (text.match(/bar\s*(bezahlt|erhalten|entgegengenommen|zahlung)/i)) {
    result.paymentMethod = 'bar';
  }

  // Kundenname: Suche nach typischen Positionen
  // Oft steht der Kundenname nach Absenderzeile und vor "Rechnung"
  let addressBlock = [];
  let foundSender = false;
  let foundInvoice = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Absenderzeile überspringen (kleine Schrift oben, oft mit · getrennt)
    if (line.includes('·') || line.match(/^(Tel|Fax|Mail|www\.|http)/i)) {
      foundSender = true;
      continue;
    }
    if (line.match(/^(RECHNUNG|Invoice|Rechnungsnummer|Rechnung\s*Nr)/i)) {
      foundInvoice = true;
      break;
    }
    // Adressblock: typisch 2-4 Zeilen zwischen Absender und Rechnungstitel
    if (foundSender && !foundInvoice && line.length > 2 && line.length < 80) {
      // PLZ + Stadt erkennen
      const plzMatch = line.match(/^(\d{5})\s+(.+)$/);
      if (plzMatch) {
        result.customerZip = plzMatch[1];
        result.customerCity = plzMatch[2];
        continue;
      }
      // Straße erkennen (enthält Hausnummer)
      if (line.match(/\d+[a-z]?\s*$/) && !line.match(/^\d{5}/)) {
        result.customerStreet = line;
        continue;
      }
      // Erster nicht-zugeordneter Eintrag = Kundenname
      if (!result.customerName && !line.match(/^\d/) && line.length > 2) {
        result.customerName = line;
      }
    }
  }

  // Fallback: Dateiname als Hinweis
  if (!result.invoiceNumber) {
    const fnMatch = fileName.match(/(?:RE|INV|RG)[-_]?\d{4}[-_]?\d{1,5}/i);
    if (fnMatch) result.invoiceNumber = fnMatch[0].replace(/_/g, '-');
  }

  return result;
}

async function importPDFInvoices() {
  const pdfs = await window.api.importPDFs();
  if (!pdfs || pdfs.length === 0) return;

  pendingImports = [];
  for (const pdf of pdfs) {
    if (pdf.error) {
      showToast(`Fehler bei ${pdf.fileName}: ${pdf.error}`, 'error');
      continue;
    }
    const parsed = parsePDFText(pdf.text, pdf.fileName);
    pendingImports.push(parsed);
  }

  if (pendingImports.length === 0) {
    showToast('Keine PDFs konnten gelesen werden', 'error');
    return;
  }

  renderImportPreview();
  document.getElementById('import-modal').classList.add('active');
}

function renderImportPreview() {
  const container = document.getElementById('import-preview');
  container.innerHTML = pendingImports.map((imp, i) => `
    <div class="import-card" style="background:var(--bg-secondary);border-radius:8px;padding:16px;margin-bottom:12px;">
      <div style="font-weight:600;margin-bottom:8px;">📄 ${escapeHtml(imp.fileName)}</div>
      <div class="form-row">
        <div class="form-group">
          <label>Rechnungsnummer</label>
          <input type="text" value="${escapeHtml(imp.invoiceNumber)}" onchange="pendingImports[${i}].invoiceNumber=this.value">
        </div>
        <div class="form-group">
          <label>Datum</label>
          <input type="date" value="${imp.date}" onchange="pendingImports[${i}].date=this.value">
        </div>
        <div class="form-group">
          <label>Betrag (€)</label>
          <input type="number" step="0.01" value="${imp.totalAmount}" onchange="pendingImports[${i}].totalAmount=parseFloat(this.value)||0">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Kundenname</label>
          <input type="text" value="${escapeHtml(imp.customerName)}" onchange="pendingImports[${i}].customerName=this.value">
        </div>
        <div class="form-group">
          <label>Straße</label>
          <input type="text" value="${escapeHtml(imp.customerStreet)}" onchange="pendingImports[${i}].customerStreet=this.value">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="flex:0.3">
          <label>PLZ</label>
          <input type="text" value="${escapeHtml(imp.customerZip)}" onchange="pendingImports[${i}].customerZip=this.value">
        </div>
        <div class="form-group">
          <label>Stadt</label>
          <input type="text" value="${escapeHtml(imp.customerCity)}" onchange="pendingImports[${i}].customerCity=this.value">
        </div>
        <div class="form-group">
          <label>Zahlungsart</label>
          <select onchange="pendingImports[${i}].paymentMethod=this.value">
            <option value="ueberweisung" ${imp.paymentMethod==='ueberweisung'?'selected':''}>Überweisung</option>
            <option value="bar" ${imp.paymentMethod==='bar'?'selected':''}>Bar bezahlt</option>
          </select>
        </div>
      </div>
    </div>
  `).join('');
}

function closeImportModal() {
  document.getElementById('import-modal').classList.remove('active');
  pendingImports = [];
}

async function confirmImport() {
  let importCount = 0;

  for (const imp of pendingImports) {
    if (!imp.invoiceNumber && !imp.customerName) continue;

    // Kunde anlegen oder bestehenden finden
    let customerId = null;
    if (imp.customerName) {
      const existing = store.customers.find(c =>
        c.name.toLowerCase() === imp.customerName.toLowerCase()
      );
      if (existing) {
        customerId = existing.id;
      } else {
        const newCustomer = store.addCustomer({
          name: imp.customerName,
          street: imp.customerStreet,
          zip: imp.customerZip,
          city: imp.customerCity,
          email: '',
          phone: '',
        });
        customerId = newCustomer.id;
      }
    }

    // Prüfen ob RE-Nr schon existiert
    const existingInvoice = store.invoices.find(inv => inv.number === imp.invoiceNumber);
    if (existingInvoice) continue;

    // Rechnung anlegen
    const invoiceData = {
      customerId: customerId,
      date: imp.date || new Date().toISOString().split('T')[0],
      dueDays: 14,
      paymentMethod: imp.paymentMethod,
      notes: `Importiert aus: ${imp.fileName}`,
      items: [{
        description: 'Importierte Position',
        quantity: 1,
        unit: 'Stk.',
        price: imp.totalAmount,
        taxRate: 19,
      }],
      taxMode: store.settings.taxMode,
      status: imp.status,
    };

    // Rechnung mit eigener Nummer erstellen (nicht auto-generiert)
    const invoice = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      number: imp.invoiceNumber || await store.getNextInvoiceNumber(),
      ...invoiceData,
      createdAt: new Date().toISOString(),
    };

    store.invoices.push(invoice);
    importCount++;
  }

  if (importCount > 0) {
    await store.saveInvoices();
    renderDashboard();
    renderCustomersList();
    showToast(`${importCount} Rechnung(en) importiert`, 'success');
  } else {
    showToast('Keine neuen Rechnungen importiert', 'error');
  }

  closeImportModal();
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
