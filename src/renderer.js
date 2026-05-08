// --- App State ---
let currentInvoiceItems = [];
let editingInvoiceId = null;
let savedItems = [];
let darkMode = false;

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // Script-Ladefehler prüfen
  if (window._scriptErrors && window._scriptErrors.length > 0) {
    console.error('Scripts konnten nicht geladen werden:', window._scriptErrors.join(', '));
    const overlay = document.getElementById('auth-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.innerHTML = `
        <div class="auth-box" style="text-align:center;padding:40px;">
          <h2 style="color:var(--danger);margin-bottom:16px;">Ladefehler</h2>
          <p style="color:var(--text-secondary);margin-bottom:12px;">Folgende Komponenten konnten nicht geladen werden:</p>
          <p style="color:var(--text-primary);font-weight:600;margin-bottom:16px;">${window._scriptErrors.join(', ')}</p>
          <p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">Bitte prüfe deine Internetverbindung und starte die App neu.</p>
          <button class="btn btn-primary" onclick="location.reload()" style="width:100%;">App neu laden</button>
        </div>
      `;
    }
    return;
  }

  // Prüfen ob store korrekt geladen wurde
  if (typeof store === 'undefined' || typeof Store === 'undefined') {
    console.error('Store nicht geladen! store:', typeof store, 'Store:', typeof Store);
    alert('Fehler: App-Daten konnten nicht geladen werden. Bitte starte die App neu.');
    return;
  }

  // Plattform-Klasse setzen für CSS
  document.body.parentElement.classList.add(`platform-${navigator.platform.includes('Mac') ? 'darwin' : 'win32'}`);

  // Dark Mode laden
  darkMode = await window.api.getDarkMode();
  applyDarkMode();

  // Firebase Config laden und verbinden
  const fbConfig = await window.api.getFirebaseConfig();
  if (fbConfig) {
    const ok = await initFirebase(fbConfig);
    if (ok) store.useFirebase = true;
  }

  // Auth-Flow:
  // 1. Keine Firebase Config → Setup-Wizard
  // 2. Firebase Config aber nicht eingeloggt → Login-Screen
  // 3. Eingeloggt → App
  if (!fbConfig) {
    document.getElementById('auth-overlay').style.display = 'flex';
    showSetupWizard();
    return;
  }

  // Firebase Auth State prüfen
  if (typeof auth !== 'undefined' && auth) {
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        // Eingeloggt
        try {
          document.getElementById('auth-overlay').style.display = 'none';
          await initApp();
        } catch (err) {
          console.error('initApp Fehler:', err);
          showToast('Fehler beim Laden: ' + err.message, 'error');
        }
      } else {
        // Nicht eingeloggt → Login zeigen
        document.getElementById('auth-overlay').style.display = 'flex';
        showAuthLogin();
      }
    });
  } else {
    // Firebase nicht initialisiert
    document.getElementById('auth-overlay').style.display = 'flex';
    showSetupWizard();
  }
  return;
});

async function initApp() {
  // Multi-Org: User-Profil laden und Org setzen
  if (store.useFirebase && auth && auth.currentUser) {
    // User-Profil laden (mit Fallback falls Methode fehlt)
    if (typeof store.loadUserProfile === 'function') {
      await store.loadUserProfile(auth.currentUser.email);
    } else {
      console.error('store.loadUserProfile fehlt! store Typ:', typeof store, 'Konstruktor:', store && store.constructor && store.constructor.name, 'Methoden:', store ? Object.getOwnPropertyNames(Object.getPrototypeOf(store)).join(',') : 'N/A');
      store.userRole = 'admin';
      store.userOrgs = [];
      store.allOrgs = [];
    }

    // Einladung verarbeiten: Neuen User automatisch dem Verein zuweisen
    if (window._pendingInviteOrgId && !store.userOrgs.includes(window._pendingInviteOrgId)) {
      try {
        if (typeof store.assignUserToOrg === 'function') {
          await store.assignUserToOrg(auth.currentUser.email, window._pendingInviteOrgId);
        }
        store.userOrgs.push(window._pendingInviteOrgId);
        store.currentOrgId = window._pendingInviteOrgId;
        await db.collection('users').doc(auth.currentUser.email).update({
          orgs: store.userOrgs,
          lastOrgId: window._pendingInviteOrgId,
        });
        showToast(`Du bist jetzt Mitglied von "${window._pendingInviteOrgName || 'Verein'}"`, 'success');
      } catch (e) {
        console.warn('Einladung konnte nicht verarbeitet werden:', e);
      }
      window._pendingInviteOrgId = null;
      window._pendingInviteOrgName = null;
    }

    renderOrgSwitcher();

    // Admin-Funktionen anzeigen/verstecken
    if (store.userRole === 'admin') {
      document.getElementById('nav-orgs').style.display = '';
    } else {
      document.getElementById('nav-orgs').style.display = 'none';
    }

    // Org zuweisen
    if (store.userRole === 'admin') {
      // Admin: Wenn keine Org existiert → Hauptverein erstellen
      if (!store.currentOrgId && store.allOrgs.length === 0) {
        const org = await store.createOrg('Hauptverein');
        if (org) {
          store.currentOrgId = org.id;
          store.userOrgs = [org.id];
          await db.collection('users').doc(auth.currentUser.email).update({
            orgs: [org.id],
            lastOrgId: org.id,
          });
        }
      } else if (!store.currentOrgId && store.allOrgs.length > 0) {
        store.currentOrgId = store.allOrgs[0].id;
      }
    } else {
      // Member: Nur auf zugewiesene Orgs zugreifen
      if (!store.currentOrgId && store.userOrgs.length > 0) {
        store.currentOrgId = store.userOrgs[0];
      } else if (store.currentOrgId && !store.userOrgs.includes(store.currentOrgId)) {
        // Gespeicherte Org ist nicht mehr zugewiesen → auf erste erlaubte wechseln
        store.currentOrgId = store.userOrgs.length > 0 ? store.userOrgs[0] : null;
      }
      // Member ohne Org-Zuweisung → Hinweis zeigen
      if (!store.currentOrgId) {
        showToast('Du bist noch keinem Verein zugewiesen. Bitte kontaktiere den Admin.', 'error');
      }
    }
  }

  await store.loadSettings();
  await store.loadCustomers();
  await store.loadInvoices();
  await store.loadExpenses();
  await store.loadDonations();
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
    if (type === 'expenses') {
      renderExpensesList();
    }
    if (type === 'donations') {
      renderDonationsList();
    }
    if (type === 'settings') {
      loadExpenseCategories();
      renderSettingsForm();
      updateInvoiceForm();
    }
  };
  store.startRealtimeSync();

  setupNavigation();
  setupForms();
  loadExpenseCategories();
  renderDashboard();
  renderCustomersList();
  renderExpensesList();
  renderDonationsList();
  initDonationYearFilter();
  await loadTeams();
  renderSettingsForm();
  renderExpenseCategoriesSettings();
  updateInvoiceForm();
  updateNumberPreview();
  initFinanceYearSelect();
}

async function syncToFirebase() {
  if (typeof db === 'undefined') return;
  if (!store.currentOrgId) return; // Kein Org → kein Sync

  try {
    const col = (name) => store._col(name);
    const settingsDoc = store._settingsDoc();

    // Settings hochladen
    if (store.settings && store.settings.company && store.settings.company.name) {
      await settingsDoc.set(store.settings);
    }

    // Kunden hochladen (nur wenn Firebase leer ist oder weniger Daten hat)
    const fbCustomers = await col('customers').get();
    if (fbCustomers.empty && store.customers.length > 0) {
      console.log('Sync: Lade', store.customers.length, 'Kunden nach Firebase hoch...');
      const batch = db.batch();
      for (const c of store.customers) {
        batch.set(col('customers').doc(c.id), c);
      }
      await batch.commit();
    } else if (!fbCustomers.empty && store.customers.length === 0) {
      store.customers = fbCustomers.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (window.api) await window.api.saveCustomers(store.customers);
    }

    // Rechnungen hochladen
    const fbInvoices = await col('invoices').get();
    if (fbInvoices.empty && store.invoices.length > 0) {
      console.log('Sync: Lade', store.invoices.length, 'Rechnungen nach Firebase hoch...');
      for (let i = 0; i < store.invoices.length; i += 400) {
        const batch = db.batch();
        const chunk = store.invoices.slice(i, i + 400);
        for (const inv of chunk) {
          batch.set(col('invoices').doc(inv.id), inv);
        }
        await batch.commit();
      }
    } else if (!fbInvoices.empty && store.invoices.length === 0) {
      store.invoices = fbInvoices.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (window.api) await window.api.saveInvoices(store.invoices);
    }

    // Ausgaben hochladen
    const fbExpenses = await col('expenses').get();
    if (fbExpenses.empty && store.expenses.length > 0) {
      console.log('Sync: Lade', store.expenses.length, 'Ausgaben nach Firebase hoch...');
      for (let i = 0; i < store.expenses.length; i += 400) {
        const batch = db.batch();
        const chunk = store.expenses.slice(i, i + 400);
        for (const exp of chunk) {
          batch.set(col('expenses').doc(exp.id), exp);
        }
        await batch.commit();
      }
    } else if (!fbExpenses.empty && store.expenses.length === 0) {
      store.expenses = fbExpenses.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (window.api) await window.api.saveExpenses(store.expenses);
    }

    // Saved Items hochladen (org-spezifisch)
    if (savedItems.length > 0) {
      await col('app').doc('savedItems').set({ items: savedItems });
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
  if (tabName === 'expenses') renderExpensesList();
  if (tabName === 'donations') renderDonationsList();
  if (tabName === 'finances') { initFinanceYearSelect(); renderFinances(); }
  if (tabName === 'new-invoice') updateInvoiceForm();
  if (tabName === 'orgs') renderOrgsList();
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
  document.getElementById('save-invoice-btn').textContent = 'Änderungen speichern';
  document.getElementById('invoice-customer').value = inv.customerId || '';
  const editCustomerObj = store.getCustomer(inv.customerId);
  document.getElementById('invoice-customer-search').value = editCustomerObj ? editCustomerObj.name : '';
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

  // Kunden-Suche aktualisieren (verstecktes Feld bleibt)
  const currentCustomerId = document.getElementById('invoice-customer').value;
  if (currentCustomerId) {
    const cust = store.getCustomer(currentCustomerId);
    if (cust) {
      document.getElementById('invoice-customer-search').value = cust.name;
    }
  }

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
      mwst += itemNetto * ((item.taxRate != null ? item.taxRate : 19) / 100);
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
  document.getElementById('save-invoice-btn').textContent = 'Rechnung erstellen';
  document.getElementById('invoice-customer').value = '';
  document.getElementById('invoice-customer-search').value = '';
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

  // Expense form
  document.getElementById('expense-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveExpense();
  });

  // Donation form
  document.getElementById('donation-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveDonation();
  });

  // Team form
  document.getElementById('team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveTeam();
  });

  // Settings form
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettingsForm();
  });

  // Org form (Multi-Verein)
  const orgForm = document.getElementById('org-form');
  if (orgForm) {
    orgForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveOrg();
    });
  }

  // Member form (Multi-Verein)
  const memberForm = document.getElementById('member-form');
  if (memberForm) {
    memberForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await addOrgMember();
    });
  }

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

// --- Customer Search Dropdown ---
function showCustomerDropdown() {
  filterCustomerDropdown();
}

function filterCustomerDropdown() {
  const input = document.getElementById('invoice-customer-search');
  const dropdown = document.getElementById('customer-dropdown');
  const query = input.value.toLowerCase().trim();

  const filtered = store.customers.filter(c =>
    c.name.toLowerCase().includes(query) ||
    (c.city || '').toLowerCase().includes(query) ||
    (c.email || '').toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.style.display = 'block';
  dropdown.innerHTML = filtered.map(c => `
    <div class="customer-dropdown-item" onclick="selectCustomer('${c.id}')">
      <div><strong>${escapeHtml(c.name)}</strong></div>
      ${c.city ? `<div class="customer-detail">${escapeHtml(c.street || '')} ${escapeHtml(c.zip || '')} ${escapeHtml(c.city)}</div>` : ''}
    </div>
  `).join('');
}

function selectCustomer(id) {
  const customer = store.getCustomer(id);
  if (!customer) return;
  document.getElementById('invoice-customer').value = id;
  document.getElementById('invoice-customer-search').value = customer.name;
  document.getElementById('customer-dropdown').style.display = 'none';
}

// Dropdown schließen bei Klick außerhalb
document.addEventListener('mousedown', (e) => {
  const dropdown = document.getElementById('customer-dropdown');
  const search = document.getElementById('invoice-customer-search');
  if (dropdown && !dropdown.contains(e.target) && e.target !== search) {
    dropdown.style.display = 'none';
  }
});

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
  await store.deleteCustomer(id);
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

  // Spendenquittung-Felder
  document.getElementById('settings-vereinszweck').value = s.vereinszweck || '';
  document.getElementById('settings-finanzamt').value = s.finanzamt || '';
  document.getElementById('settings-freistellungsdatum').value = s.freistellungsDatum || '';
  document.getElementById('settings-veranlagungszeitraum').value = s.veranlagungszeitraum || '';

  // Data path
  const dataPath = await window.api.getDataPath();
  document.getElementById('settings-data-path').value = dataPath;

  // Logo
  await renderLogoPreview();
  updateNumberPreview();
  loadExpenseCategories();
  renderExpenseCategoriesSettings();
  renderSavedItemsList();
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
    // Spendenquittung
    vereinszweck: document.getElementById('settings-vereinszweck').value.trim(),
    finanzamt: document.getElementById('settings-finanzamt').value.trim(),
    freistellungsDatum: document.getElementById('settings-freistellungsdatum').value.trim(),
    veranlagungszeitraum: document.getElementById('settings-veranlagungszeitraum').value.trim(),
  };

  // Ausgaben-Kategorien beibehalten
  if (store.settings && store.settings.expenseCategories) {
    settings.expenseCategories = store.settings.expenseCategories;
  }

  await store.saveSettings(settings);
  showToast('Einstellungen gespeichert', 'success');
  updateInvoiceForm();
}

// ==========================
// SETUP WIZARD
// ==========================
let wizardCurrentStep = 1;
const WIZARD_TOTAL_STEPS = 6;

function showSetupWizard() {
  document.getElementById('setup-wizard').style.display = 'block';
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-register-form').style.display = 'none';
  wizardCurrentStep = 1;
  updateWizardUI();
}

function updateWizardUI() {
  // Steps anzeigen/verstecken
  document.querySelectorAll('.wizard-step').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.step) === wizardCurrentStep);
  });
  // Progress-Indikatoren
  document.querySelectorAll('.wizard-step-indicator').forEach(ind => {
    const step = parseInt(ind.dataset.step);
    ind.classList.remove('active', 'completed');
    if (step < wizardCurrentStep) ind.classList.add('completed');
    else if (step === wizardCurrentStep) ind.classList.add('active');
  });
}

function wizardNext() {
  if (wizardCurrentStep < WIZARD_TOTAL_STEPS) {
    wizardCurrentStep++;
    updateWizardUI();
  }
}

function wizardBack() {
  if (wizardCurrentStep > 1) {
    wizardCurrentStep--;
    updateWizardUI();
  }
}

async function wizardFinish() {
  const errorEl = document.getElementById('wiz-error');
  const btn = document.querySelector('.wizard-step.active .btn-primary') ||
              document.querySelector('.wizard-step[data-step="6"] .btn-primary');
  errorEl.textContent = '';

  let config = null;

  // 1. Versuche aus dem Paste-Feld zu parsen
  const pasteField = document.getElementById('wiz-fb-paste');
  if (pasteField && pasteField.value.trim()) {
    config = parseFirebaseConfigBlock(pasteField.value.trim());
    if (!config) {
      showAuthError(errorEl, 'Konnte die Config nicht lesen. Bitte den ganzen firebaseConfig-Block kopieren (mit den geschweiften Klammern).');
      return;
    }
  }

  // 2. Fallback: Einzelfelder
  if (!config) {
    config = {
      apiKey: document.getElementById('wiz-fb-apiKey').value.trim(),
      authDomain: document.getElementById('wiz-fb-authDomain').value.trim(),
      projectId: document.getElementById('wiz-fb-projectId').value.trim(),
      storageBucket: document.getElementById('wiz-fb-storageBucket').value.trim(),
      messagingSenderId: document.getElementById('wiz-fb-messagingSenderId').value.trim(),
      appId: document.getElementById('wiz-fb-appId').value.trim(),
    };
  }

  if (!config.apiKey || !config.projectId) {
    showAuthError(errorEl, 'Bitte die Firebase Config einfügen (API Key und Project ID werden benötigt)');
    return;
  }

  // authDomain automatisch ableiten falls leer
  if (!config.authDomain && config.projectId) {
    config.authDomain = config.projectId + '.firebaseapp.com';
  }

  // Loading
  if (btn) { btn.disabled = true; btn.textContent = 'Verbinde...'; }

  try {
    const success = await initFirebase(config);
    if (!success) {
      showAuthError(errorEl, 'Firebase Verbindung fehlgeschlagen – bitte Daten prüfen');
      return;
    }

    await window.api.saveFirebaseConfig(config);
    store.useFirebase = true;

    // Auth-Listener registrieren (wurde beim Wizard-Flow nicht gesetzt)
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        try {
          document.getElementById('auth-overlay').style.display = 'none';
          await initApp();
        } catch (err) {
          console.error('initApp Fehler:', err);
          showToast('Fehler beim Laden: ' + err.message, 'error');
        }
      } else {
        document.getElementById('auth-overlay').style.display = 'flex';
        showAuthLogin();
      }
    });

    // Wizard ausblenden, Register zeigen
    document.getElementById('setup-wizard').style.display = 'none';
    showAuthRegister();
    showToast('Firebase verbunden! Erstelle jetzt dein Konto.', 'success');
  } catch (err) {
    console.error('wizardFinish Fehler:', err);
    showAuthError(errorEl, 'Fehler: ' + (err.message || 'Unbekannter Fehler'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verbinden & weiter →'; }
  }
}

// Firebase Config aus kopiertem JS-Block parsen
function parseFirebaseConfigBlock(text) {
  try {
    // Versuche JSON-artige Werte rauszulesen
    const extract = (key) => {
      const patterns = [
        new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`),
        new RegExp(`${key}\\s*[:=]\\s*["']([^"']+)["']`),
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1];
      }
      return '';
    };

    const config = {
      apiKey: extract('apiKey'),
      authDomain: extract('authDomain'),
      projectId: extract('projectId'),
      storageBucket: extract('storageBucket'),
      messagingSenderId: extract('messagingSenderId'),
      appId: extract('appId'),
    };

    if (config.apiKey && config.projectId) return config;
    return null;
  } catch (e) {
    return null;
  }
}

// ==========================
// AUTH (Firebase Auth)
// ==========================
function showAuthLogin() {
  document.getElementById('setup-wizard').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'block';
  document.getElementById('auth-register-form').style.display = 'none';
  document.getElementById('auth-error').textContent = '';
  setTimeout(() => document.getElementById('auth-email').focus(), 50);
}

function showAuthRegister() {
  document.getElementById('setup-wizard').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-register-form').style.display = 'block';
  document.getElementById('auth-reg-error').textContent = '';
  setTimeout(() => document.getElementById('auth-reg-email').focus(), 50);
}

function firebaseAuthErrorMessage(err) {
  const code = err.code || '';
  if (code.includes('user-not-found')) return 'Kein Konto mit dieser E-Mail gefunden';
  if (code.includes('wrong-password')) return 'Falsches Passwort';
  if (code.includes('invalid-credential')) return 'E-Mail oder Passwort falsch';
  if (code.includes('invalid-email')) return 'Ungültige E-Mail-Adresse';
  if (code.includes('email-already-in-use')) return 'Diese E-Mail ist bereits registriert';
  if (code.includes('weak-password')) return 'Passwort zu schwach (min. 6 Zeichen)';
  if (code.includes('too-many-requests')) return 'Zu viele Versuche – bitte später erneut';
  if (code.includes('network')) return 'Netzwerkfehler – Internet prüfen';
  if (code.includes('operation-not-allowed')) return 'E-Mail/Passwort-Login nicht aktiviert – in Firebase Console unter Authentication → Sign-in method → Email/Password aktivieren';
  if (code.includes('configuration-not-found')) return 'Authentication nicht eingerichtet – gehe in die Firebase Console → Authentication → „Jetzt starten" klicken → Email/Password aktivieren';
  return err.message || 'Unbekannter Fehler';
}

async function authLogin() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errorEl = document.getElementById('auth-error');
  const btn = document.querySelector('#auth-login-form .auth-btn');

  errorEl.textContent = '';

  if (!email || !password) {
    showAuthError(errorEl, 'Bitte E-Mail und Passwort eingeben');
    return;
  }

  if (typeof auth === 'undefined' || !auth) {
    showAuthError(errorEl, 'Firebase nicht verbunden – bitte App neu starten');
    return;
  }

  // Loading-State
  if (btn) { btn.disabled = true; btn.textContent = 'Anmelden...'; }

  try {
    const loginPromise = auth.signInWithEmailAndPassword(email, password);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 15000)
    );
    await Promise.race([loginPromise, timeoutPromise]);
    showToast('Erfolgreich angemeldet', 'success');
  } catch (err) {
    const msg = err.message === 'timeout'
      ? 'Verbindung dauert zu lange – bitte App neu starten'
      : firebaseAuthErrorMessage(err);
    showAuthError(errorEl, msg);
    document.getElementById('auth-password').value = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Anmelden'; }
  }
}

// Fehlermeldung deutlich sichtbar anzeigen mit Shake-Animation
function showAuthError(el, message) {
  el.textContent = message;
  el.style.display = 'block';
  // Shake-Animation auslösen
  const box = el.closest('.auth-box') || el.parentElement;
  box.classList.remove('shake');
  void box.offsetWidth; // Force reflow
  box.classList.add('shake');
}

async function authRegister() {
  const email = document.getElementById('auth-reg-email').value.trim();
  const password = document.getElementById('auth-reg-password').value;
  const password2 = document.getElementById('auth-reg-password2').value;
  const errorEl = document.getElementById('auth-reg-error');
  const btn = document.querySelector('#auth-register-form .auth-btn');

  errorEl.textContent = '';

  if (!email || !password) {
    showAuthError(errorEl, 'Bitte alle Felder ausfüllen');
    return;
  }
  if (password.length < 6) {
    showAuthError(errorEl, 'Passwort muss mindestens 6 Zeichen haben');
    return;
  }
  if (password !== password2) {
    showAuthError(errorEl, 'Passwörter stimmen nicht überein');
    return;
  }

  if (typeof auth === 'undefined' || !auth) {
    showAuthError(errorEl, 'Firebase nicht verbunden – bitte Setup durchführen');
    return;
  }

  // Loading-State
  if (btn) { btn.disabled = true; btn.textContent = 'Erstelle Konto...'; }

  try {
    const registerPromise = auth.createUserWithEmailAndPassword(email, password);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 15000)
    );
    await Promise.race([registerPromise, timeoutPromise]);
    showToast(`Willkommen, ${email}!`, 'success');
  } catch (err) {
    if (err.message === 'timeout') {
      showAuthError(errorEl, 'Verbindung dauert zu lange – bitte App neu starten');
    } else {
      showAuthError(errorEl, firebaseAuthErrorMessage(err));
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Konto erstellen'; }
  }
}

async function authLogout() {
  if (typeof auth !== 'undefined' && auth) {
    await auth.signOut();
  }
  location.reload();
}

async function authForgotPassword() {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) {
    document.getElementById('auth-error').textContent = 'Bitte E-Mail eingeben, dann auf "Passwort vergessen" klicken';
    document.getElementById('auth-email').focus();
    return;
  }

  if (typeof auth === 'undefined' || !auth) {
    document.getElementById('auth-error').textContent = 'Firebase nicht verbunden';
    return;
  }

  try {
    await auth.sendPasswordResetEmail(email);
    document.getElementById('auth-error').textContent = '';
    alert(`Eine E-Mail zum Zurücksetzen des Passworts wurde an ${email} gesendet. Prüfe auch den Spam-Ordner!`);
  } catch (err) {
    document.getElementById('auth-error').textContent = firebaseAuthErrorMessage(err);
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
function parseFirebaseConfig(input) {
  // Versuche direkt als JSON zu parsen
  try {
    const parsed = JSON.parse(input);
    if (parsed.apiKey) return parsed;
  } catch (_) {}

  // Firebase-Code-Block: extrahiere das Config-Objekt
  // Entferne Links im Markdown-Format: [text](url) → text
  let cleaned = input.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Suche nach dem firebaseConfig Objekt
  const match = cleaned.match(/\{[^{}]*apiKey[^{}]*\}/s);
  if (match) {
    let configStr = match[0];
    // Property-Namen in Anführungszeichen setzen: apiKey: → "apiKey":
    configStr = configStr.replace(/(\w+)\s*:/g, '"$1":');
    // Doppelte Anführungszeichen bei bereits vorhandenen fixen
    configStr = configStr.replace(/""+/g, '"');
    // Semikolon am Ende entfernen
    configStr = configStr.replace(/;\s*$/, '');
    // Trailing comma vor } entfernen
    configStr = configStr.replace(/,\s*}/g, '}');
    try {
      return JSON.parse(configStr);
    } catch (_) {}
  }

  return null;
}

async function connectFirebase() {
  const config = {
    apiKey: document.getElementById('fb-apiKey').value.trim(),
    authDomain: document.getElementById('fb-authDomain').value.trim(),
    projectId: document.getElementById('fb-projectId').value.trim(),
    storageBucket: document.getElementById('fb-storageBucket').value.trim(),
    messagingSenderId: document.getElementById('fb-messagingSenderId').value.trim(),
    appId: document.getElementById('fb-appId').value.trim(),
  };

  if (!config.apiKey || !config.projectId) {
    showToast('Bitte mindestens API Key und Project ID eingeben', 'error');
    return;
  }

  const success = await initFirebase(config);
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
    const opts = firebase.app().options;
    el.innerHTML = `<span style="color:var(--success);font-weight:600;">✅ Verbunden</span> <span style="color:var(--text-secondary);font-size:12px;">— Projekt: ${opts.projectId || 'Unbekannt'}</span>`;
    // Felder vorausfüllen
    document.getElementById('fb-apiKey').value = opts.apiKey || '';
    document.getElementById('fb-authDomain').value = opts.authDomain || '';
    document.getElementById('fb-projectId').value = opts.projectId || '';
    document.getElementById('fb-storageBucket').value = opts.storageBucket || '';
    document.getElementById('fb-messagingSenderId').value = opts.messagingSenderId || '';
    document.getElementById('fb-appId').value = opts.appId || '';
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

// ==========================
// EXPENSES (Ausgaben)
// ==========================
const DEFAULT_EXPENSE_CATEGORIES = {
  material: { label: 'Material & Waren', icon: '📦' },
  buero: { label: 'Büro & Ausstattung', icon: '🖨️' },
  software: { label: 'Software & Lizenzen', icon: '💻' },
  fahrt: { label: 'Fahrtkosten', icon: '🚗' },
  versicherung: { label: 'Versicherungen', icon: '🛡️' },
  telefon: { label: 'Telefon & Internet', icon: '📱' },
  werbung: { label: 'Werbung & Marketing', icon: '📣' },
  beratung: { label: 'Beratung & Buchhaltung', icon: '📋' },
  miete: { label: 'Miete & Nebenkosten', icon: '🏠' },
  sonstiges: { label: 'Sonstiges', icon: '📎' },
};

let EXPENSE_CATEGORIES = { ...DEFAULT_EXPENSE_CATEGORIES };

function loadExpenseCategories() {
  if (store.settings && store.settings.expenseCategories) {
    EXPENSE_CATEGORIES = store.settings.expenseCategories;
  } else {
    EXPENSE_CATEGORIES = { ...DEFAULT_EXPENSE_CATEGORIES };
  }
  updateCategoryDropdowns();
}

function updateCategoryDropdowns() {
  // Alle Kategorie-Dropdowns im DOM aktualisieren
  const selects = document.querySelectorAll('#expense-category, #filter-expense-category, #inp-category');
  selects.forEach(select => {
    const currentVal = select.value;
    const isFilter = select.id === 'filter-expense-category';
    let html = isFilter ? '<option value="">Alle Kategorien</option>' : '';
    for (const [key, cat] of Object.entries(EXPENSE_CATEGORIES)) {
      html += `<option value="${key}">${cat.icon} ${cat.label}</option>`;
    }
    select.innerHTML = html;
    if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
      select.value = currentVal;
    }
  });
}

function renderExpenseCategoriesSettings() {
  const container = document.getElementById('expense-categories-settings');
  if (!container) return;

  const entries = Object.entries(EXPENSE_CATEGORIES);
  container.innerHTML = entries.map(([key, cat]) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-light);">
      <input type="text" value="${cat.icon}" style="width:44px;text-align:center;padding:6px;border:1px solid var(--border);border-radius:6px;font-size:16px;background:var(--bg-tertiary);" onchange="updateExpenseCategory('${key}','icon',this.value)">
      <input type="text" value="${escapeHtml(cat.label)}" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg-secondary);color:var(--text-primary);" onchange="updateExpenseCategory('${key}','label',this.value)">
      <button type="button" class="btn-icon" onclick="removeExpenseCategory('${key}')" title="Entfernen" style="color:var(--danger);">✕</button>
    </div>
  `).join('');
}

function updateExpenseCategory(key, field, value) {
  if (!EXPENSE_CATEGORIES[key]) return;
  EXPENSE_CATEGORIES[key][field] = value;
  saveExpenseCategoriesToSettings();
}

function removeExpenseCategory(key) {
  if (Object.keys(EXPENSE_CATEGORIES).length <= 1) {
    showToast('Mindestens eine Kategorie muss bleiben', 'error');
    return;
  }
  delete EXPENSE_CATEGORIES[key];
  saveExpenseCategoriesToSettings();
  renderExpenseCategoriesSettings();
}

function addExpenseCategory() {
  const id = 'kat_' + Date.now().toString(36);
  EXPENSE_CATEGORIES[id] = { label: 'Neue Kategorie', icon: '📁' };
  saveExpenseCategoriesToSettings();
  renderExpenseCategoriesSettings();
}

async function saveExpenseCategoriesToSettings() {
  store.settings.expenseCategories = { ...EXPENSE_CATEGORIES };
  await store.saveSettings(store.settings);
  updateCategoryDropdowns();
}

function renderExpensesList() {
  const tbody = document.getElementById('expenses-tbody');
  const empty = document.getElementById('expenses-empty');
  const table = document.getElementById('expenses-table');
  const catFilter = document.getElementById('filter-expense-category').value;
  const teamFilter = document.getElementById('filter-expense-team').value;

  let expenses = [...store.expenses];
  if (catFilter) {
    expenses = expenses.filter(e => e.category === catFilter);
  }
  if (teamFilter === '_none') {
    expenses = expenses.filter(e => !e.teamId);
  } else if (teamFilter) {
    expenses = expenses.filter(e => e.teamId === teamFilter);
  }

  // Stats
  const now = new Date();
  const thisMonth = store.expenses.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const thisYear = store.expenses.filter(e => new Date(e.date).getFullYear() === now.getFullYear());

  document.getElementById('stat-expenses-month').textContent = formatCurrency(thisMonth.reduce((s, e) => s + (e.amount || 0), 0));
  document.getElementById('stat-expenses-year').textContent = formatCurrency(thisYear.reduce((s, e) => s + (e.amount || 0), 0));
  document.getElementById('stat-expenses-count').textContent = store.expenses.length;

  if (expenses.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  const sorted = expenses.sort((a, b) => new Date(b.date) - new Date(a.date));

  tbody.innerHTML = sorted.map(exp => {
    const cat = EXPENSE_CATEGORIES[exp.category] || EXPENSE_CATEGORIES.sonstiges;
    const teamName = exp.teamId ? (teams.find(t => t.id === exp.teamId) || {}).name : '';
    const submitter = exp.submittedBy ? `<span class="badge" style="background:var(--accent-subtle);color:var(--accent);font-size:10px;padding:2px 8px;margin-left:6px;">${escapeHtml(exp.submittedBy)}</span>` : '';
    const teamBadge = teamName ? `<span class="badge" style="background:var(--warning-subtle);color:var(--warning);font-size:10px;padding:2px 8px;margin-left:4px;">${escapeHtml(teamName)}</span>` : '';
    return `<tr>
      <td>${formatDate(exp.date)}</td>
      <td><strong>${escapeHtml(exp.description)}</strong>${submitter}${teamBadge}${exp.notes && !exp.submittedBy ? `<br><small style="color:var(--text-tertiary)">${escapeHtml(exp.notes)}</small>` : ''}</td>
      <td><span style="display:inline-flex;align-items:center;gap:4px;">${cat.icon} ${cat.label}</span></td>
      <td><strong>${formatCurrency(exp.amount)}</strong></td>
      <td>
        <button class="btn-icon" onclick="editExpense('${exp.id}')" title="Bearbeiten">&#9998;</button>
        <button class="btn-icon" onclick="deleteExpense('${exp.id}')" title="Löschen">&#128465;</button>
      </td>
    </tr>`;
  }).join('');
}

function showExpenseForm(expense = null) {
  const modal = document.getElementById('expense-modal');
  const title = document.getElementById('expense-modal-title');

  if (expense) {
    title.textContent = 'Ausgabe bearbeiten';
    document.getElementById('expense-edit-id').value = expense.id;
    document.getElementById('expense-date').value = expense.date || '';
    document.getElementById('expense-amount').value = expense.amount || '';
    document.getElementById('expense-description').value = expense.description || '';
    document.getElementById('expense-category').value = expense.category || 'sonstiges';
    document.getElementById('expense-tax').value = expense.taxRate != null ? expense.taxRate : 19;
    document.getElementById('expense-notes').value = expense.notes || '';
  } else {
    title.textContent = 'Neue Ausgabe';
    document.getElementById('expense-edit-id').value = '';
    document.getElementById('expense-form').reset();
    document.getElementById('expense-date').value = new Date().toISOString().split('T')[0];
  }

  modal.classList.add('active');
}

function closeExpenseModal() {
  document.getElementById('expense-modal').classList.remove('active');
}

function editExpense(id) {
  const expense = store.getExpense(id);
  if (expense) showExpenseForm(expense);
}

async function deleteExpense(id) {
  if (!confirm('Ausgabe wirklich löschen?')) return;
  await store.deleteExpense(id);
  renderExpensesList();
  renderTeamsList();
  showToast('Ausgabe gelöscht');
}

async function saveExpense() {
  const editId = document.getElementById('expense-edit-id').value;
  const data = {
    date: document.getElementById('expense-date').value,
    amount: parseFloat(document.getElementById('expense-amount').value) || 0,
    description: document.getElementById('expense-description').value.trim(),
    category: document.getElementById('expense-category').value,
    taxRate: parseInt(document.getElementById('expense-tax').value),
    notes: document.getElementById('expense-notes').value.trim(),
  };

  if (!data.description || !data.amount) {
    showToast('Bitte Beschreibung und Betrag eingeben', 'error');
    return;
  }

  if (editId) {
    await store.updateExpense(editId, data);
    showToast('Ausgabe aktualisiert', 'success');
  } else {
    await store.addExpense(data);
    showToast('Ausgabe erfasst', 'success');
  }

  closeExpenseModal();
  renderExpensesList();
  renderTeamsList();
}

function filterExpenses() {
  const query = document.getElementById('search-expenses').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#expenses-tbody tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

// ==========================
// SPENDEN (Donations)
// ==========================

function showDonationForm(editId) {
  const modal = document.getElementById('donation-modal');
  const title = document.getElementById('donation-modal-title');
  document.getElementById('donation-edit-id').value = editId || '';

  if (editId) {
    title.textContent = 'Spende bearbeiten';
    const d = store.getDonation(editId);
    if (d) {
      document.getElementById('donation-date').value = d.date || '';
      document.getElementById('donation-type').value = d.type || 'geld';
      document.getElementById('donation-amount').value = d.amount || '';
      document.getElementById('donation-purpose').value = d.purpose || '';
      document.getElementById('donation-donor-name').value = d.donorName || '';
      document.getElementById('donation-donor-address').value = d.donorAddress || '';
      document.getElementById('donation-donor-zip').value = d.donorZip || '';
      document.getElementById('donation-donor-city').value = d.donorCity || '';
      document.getElementById('donation-notes').value = d.notes || '';
    }
  } else {
    title.textContent = 'Neue Spende erfassen';
    document.getElementById('donation-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('donation-type').value = 'geld';
    document.getElementById('donation-amount').value = '';
    document.getElementById('donation-purpose').value = '';
    document.getElementById('donation-donor-name').value = '';
    document.getElementById('donation-donor-address').value = '';
    document.getElementById('donation-donor-zip').value = '';
    document.getElementById('donation-donor-city').value = '';
    document.getElementById('donation-notes').value = '';
  }

  modal.classList.add('active');
}

function closeDonationModal() {
  document.getElementById('donation-modal').classList.remove('active');
}

async function saveDonation() {
  const editId = document.getElementById('donation-edit-id').value;
  const data = {
    date: document.getElementById('donation-date').value,
    type: document.getElementById('donation-type').value,
    amount: parseFloat(document.getElementById('donation-amount').value) || 0,
    purpose: document.getElementById('donation-purpose').value.trim(),
    donorName: document.getElementById('donation-donor-name').value.trim(),
    donorAddress: document.getElementById('donation-donor-address').value.trim(),
    donorZip: document.getElementById('donation-donor-zip').value.trim(),
    donorCity: document.getElementById('donation-donor-city').value.trim(),
    notes: document.getElementById('donation-notes').value.trim(),
  };

  if (!data.donorName || !data.amount) {
    showToast('Bitte Spendername und Betrag eingeben', 'error');
    return;
  }

  if (editId) {
    await store.updateDonation(editId, data);
    showToast('Spende aktualisiert', 'success');
  } else {
    data.number = store.getNextDonationNumber('SQ');
    await store.addDonation(data);
    showToast('Spende erfasst', 'success');
  }

  closeDonationModal();
  renderDonationsList();
}

async function deleteDonation(id) {
  if (!confirm('Spende wirklich löschen?')) return;
  await store.deleteDonation(id);
  renderDonationsList();
  showToast('Spende gelöscht');
}

function renderDonationsList() {
  const tbody = document.getElementById('donations-tbody');
  const empty = document.getElementById('donations-empty');
  const table = document.getElementById('donations-table');
  if (!tbody) return;

  const yearFilter = document.getElementById('filter-donation-year').value;
  const typeFilter = document.getElementById('filter-donation-type').value;

  let donations = [...store.donations];

  if (yearFilter) {
    donations = donations.filter(d => new Date(d.date).getFullYear().toString() === yearFilter);
  }
  if (typeFilter) {
    donations = donations.filter(d => d.type === typeFilter);
  }

  // Stats
  const now = new Date();
  const allTotal = store.donations.reduce((s, d) => s + (d.amount || 0), 0);
  const yearTotal = store.donations
    .filter(d => new Date(d.date).getFullYear() === now.getFullYear())
    .reduce((s, d) => s + (d.amount || 0), 0);
  const uniqueDonors = new Set(store.donations.map(d => d.donorName)).size;

  document.getElementById('stat-donations-count').textContent = store.donations.length;
  document.getElementById('stat-donations-total').textContent = formatCurrency(allTotal);
  document.getElementById('stat-donations-year').textContent = formatCurrency(yearTotal);
  document.getElementById('stat-donors-count').textContent = uniqueDonors;

  if (donations.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  const sorted = [...donations].sort((a, b) => new Date(b.date) - new Date(a.date));

  tbody.innerHTML = sorted.map(d => `
    <tr>
      <td><strong>${d.number || '—'}</strong></td>
      <td>${formatDate(d.date)}</td>
      <td>${escapeHtml(d.donorName)}</td>
      <td>${formatCurrency(d.amount)}</td>
      <td><span class="badge ${d.type === 'sach' ? 'badge-cancelled' : 'badge-paid'}">${d.type === 'sach' ? 'Sachspende' : 'Geldspende'}</span></td>
      <td>${escapeHtml(d.purpose || '—')}</td>
      <td>
        <button class="btn-icon" title="Quittung PDF" onclick="exportDonationPDF('${d.id}')">📄</button>
        <button class="btn-icon" title="Bearbeiten" onclick="showDonationForm('${d.id}')">✏️</button>
        <button class="btn-icon" title="Löschen" onclick="deleteDonation('${d.id}')">🗑️</button>
      </td>
    </tr>
  `).join('');
}

function filterDonations() {
  const query = document.getElementById('search-donations').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#donations-tbody tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

function initDonationYearFilter() {
  const select = document.getElementById('filter-donation-year');
  if (!select) return;
  const years = new Set(store.donations.map(d => new Date(d.date).getFullYear()));
  const currentYear = new Date().getFullYear();
  years.add(currentYear);
  const sorted = [...years].sort((a, b) => b - a);
  select.innerHTML = '<option value="">Alle Jahre</option>' +
    sorted.map(y => `<option value="${y}">${y}</option>`).join('');
}

// --- Sammelquittung ---
function showSammelquittungDialog() {
  const donors = [...new Set(store.donations.map(d => d.donorName))].filter(Boolean).sort();
  const years = [...new Set(store.donations.map(d => new Date(d.date).getFullYear()))].sort((a, b) => b - a);
  const currentYear = new Date().getFullYear();
  if (!years.includes(currentYear)) years.unshift(currentYear);

  const donorSelect = document.getElementById('sammel-donor');
  donorSelect.innerHTML = '<option value="">Bitte wählen...</option>' +
    donors.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');

  const yearSelect = document.getElementById('sammel-year');
  yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');

  document.getElementById('sammel-preview').style.display = 'none';
  document.getElementById('sammelquittung-modal').classList.add('active');
}

function closeSammelquittungModal() {
  document.getElementById('sammelquittung-modal').classList.remove('active');
}

function updateSammelPreview() {
  const donor = document.getElementById('sammel-donor').value;
  const year = parseInt(document.getElementById('sammel-year').value);
  const preview = document.getElementById('sammel-preview');

  if (!donor) { preview.style.display = 'none'; return; }

  const matching = store.donations.filter(d =>
    d.donorName === donor && new Date(d.date).getFullYear() === year
  );

  const total = matching.reduce((s, d) => s + (d.amount || 0), 0);
  document.getElementById('sammel-count').textContent = matching.length;
  document.getElementById('sammel-total').textContent = formatCurrency(total);
  preview.style.display = matching.length > 0 ? '' : 'none';
}

async function generateSammelquittung() {
  const donor = document.getElementById('sammel-donor').value;
  const year = parseInt(document.getElementById('sammel-year').value);

  if (!donor) { showToast('Bitte einen Spender auswählen', 'error'); return; }

  const donations = store.donations.filter(d =>
    d.donorName === donor && new Date(d.date).getFullYear() === year
  );

  if (donations.length === 0) { showToast('Keine Spenden für diesen Zeitraum gefunden', 'error'); return; }

  try {
    const settings = store.settings || {};
    let logoData = null;
    const logoPath = await window.api.getLogo();
    if (logoPath) logoData = await window.api.readLogoBase64(logoPath);

    const pdfBytes = await generateDonationReceiptPDF({
      donations,
      settings,
      logoData,
      isSammel: true,
      year,
    });

    const fileName = `Sammelbestätigung_${donor.replace(/[^a-zA-Z0-9äöüÄÖÜß]/g, '_')}_${year}`;
    await window.api.saveAutoPDF(pdfBytes, fileName);
    showToast(`Sammelbestätigung für ${donor} erstellt`, 'success');
    closeSammelquittungModal();
  } catch (err) {
    console.error('Sammelquittung Fehler:', err);
    showToast('Fehler beim Erstellen: ' + err.message, 'error');
  }
}

async function exportDonationPDF(donationId) {
  const donation = store.getDonation(donationId);
  if (!donation) return;

  try {
    const settings = store.settings || {};
    let logoData = null;
    const logoPath = await window.api.getLogo();
    if (logoPath) logoData = await window.api.readLogoBase64(logoPath);

    const pdfBytes = await generateDonationReceiptPDF({
      donations: [donation],
      settings,
      logoData,
      isSammel: false,
    });

    const fileName = donation.number || `Spendenquittung_${donation.donorName}`;
    await window.api.saveAutoPDF(pdfBytes, fileName.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '_'));
    showToast('Spendenquittung als PDF gespeichert', 'success');
  } catch (err) {
    console.error('Spendenquittung PDF Fehler:', err);
    showToast('Fehler: ' + err.message, 'error');
  }
}

// ==========================
// TEAMS
// ==========================
let teams = [];

async function loadTeams() {
  if (store.useFirebase && db) {
    try {
      const snapshot = await store._col('teams').get();
      teams = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (e) { console.warn('Teams load failed:', e); }
  }
  renderTeamsList();
  updateTeamFilter();
}

function renderTeamsList() {
  const container = document.getElementById('teams-list');
  if (!container) return;

  if (teams.length === 0) {
    container.innerHTML = '<p style="color:var(--text-tertiary);font-size:13px;padding:8px 0;">Noch keine Teams erstellt.</p>';
    return;
  }

  container.innerHTML = teams.map(team => {
    const teamExpenses = store.expenses.filter(e => e.teamId === team.id);
    const totalAmount = teamExpenses.reduce((s, e) => s + (e.amount || 0), 0);
    return `
      <div class="top-customer-row">
        <span style="font-size:20px;">👥</span>
        <div class="top-customer-info">
          <div class="top-customer-name">${escapeHtml(team.name)}</div>
          <div class="top-customer-count">${teamExpenses.length} Ausgabe${teamExpenses.length !== 1 ? 'n' : ''}</div>
        </div>
        <span class="top-customer-amount">${formatCurrency(totalAmount)}</span>
        <button class="btn btn-small" onclick="showTeamLink('${team.id}')" title="Link teilen">🔗 Link</button>
        <button class="btn-icon" onclick="deleteTeam('${team.id}')" title="Löschen">🗑️</button>
      </div>
    `;
  }).join('');
}

function updateTeamFilter() {
  const select = document.getElementById('filter-expense-team');
  if (!select) return;
  // Keep first two options (Alle Teams, Ohne Team), add team options
  const existing = select.querySelectorAll('option[data-team]');
  existing.forEach(o => o.remove());
  teams.forEach(team => {
    const opt = document.createElement('option');
    opt.value = team.id;
    opt.textContent = team.name;
    opt.dataset.team = '1';
    select.appendChild(opt);
  });
}

function showTeamForm() {
  if (!store.useFirebase || !db) {
    showToast('Firebase muss verbunden sein für Teams', 'error');
    return;
  }
  document.getElementById('team-modal').classList.add('active');
  document.getElementById('team-edit-id').value = '';
  document.getElementById('team-name').value = '';
  document.getElementById('team-modal-title').textContent = 'Neues Team';
}

function closeTeamModal() {
  document.getElementById('team-modal').classList.remove('active');
}

async function saveTeam() {
  const name = document.getElementById('team-name').value.trim();
  if (!name) {
    showToast('Bitte einen Teamnamen eingeben', 'error');
    return;
  }

  const team = {
    name,
    createdAt: new Date().toISOString(),
  };

  try {
    const docRef = await store._col('teams').add(team);
    team.id = docRef.id;
    teams.push(team);
    renderTeamsList();
    updateTeamFilter();
    closeTeamModal();
    showToast(`Team "${name}" erstellt`, 'success');
  } catch (e) {
    showToast('Fehler: ' + e.message, 'error');
  }
}

function showTeamLink(teamId) {
  const team = teams.find(t => t.id === teamId);
  if (!team) return;

  // Firebase Config für den Link kodieren
  const config = firebase.app().options;
  const encodedConfig = btoa(JSON.stringify({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket,
    messagingSenderId: config.messagingSenderId,
    appId: config.appId,
  }));

  // URL bauen (GitHub Pages) — mit orgId für org-scoped Teams
  const baseUrl = 'https://malikk065.github.io/Zakflow/docs/team.html';
  const orgParam = store.currentOrgId ? `&o=${store.currentOrgId}` : '';
  const url = `${baseUrl}?t=${teamId}&c=${encodedConfig}${orgParam}`;

  document.getElementById('team-link-url').value = url;
  document.getElementById('team-link-modal').classList.add('active');
}

function closeTeamLinkModal() {
  document.getElementById('team-link-modal').classList.remove('active');
}

function copyTeamLink() {
  const input = document.getElementById('team-link-url');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('Link kopiert!', 'success');
  }).catch(() => {
    // Fallback
    document.execCommand('copy');
    showToast('Link kopiert!', 'success');
  });
}

async function deleteTeam(id) {
  const team = teams.find(t => t.id === id);
  if (!confirm(`Team "${team ? team.name : ''}" wirklich löschen? Die Ausgaben bleiben erhalten.`)) return;

  try {
    await store._col('teams').doc(id).delete();
    teams = teams.filter(t => t.id !== id);
    renderTeamsList();
    updateTeamFilter();
    showToast('Team gelöscht');
  } catch (e) {
    showToast('Fehler: ' + e.message, 'error');
  }
}

// ==========================
// FINANCES (Finanzen-Tab)
// ==========================
function renderFinances() {
  const yearSelect = document.getElementById('finance-year');
  const selectedYear = parseInt(yearSelect.value) || new Date().getFullYear();

  // Einnahmen (bezahlte Rechnungen im gewählten Jahr)
  const yearInvoices = store.invoices.filter(inv => {
    const d = new Date(inv.date);
    return d.getFullYear() === selectedYear && inv.status === 'bezahlt' && inv.type !== 'gutschrift';
  });

  let totalRevenue = 0;
  let totalMwstEinnahmen = 0;
  yearInvoices.forEach(inv => {
    const totals = store.calculateInvoiceTotal(inv);
    totalRevenue += totals.netto;
    totalMwstEinnahmen += totals.mwst;
  });

  // Ausgaben im gewählten Jahr
  const yearExpenses = store.expenses.filter(e => new Date(e.date).getFullYear() === selectedYear);
  let totalExpenses = 0;
  let totalMwstAusgaben = 0;
  yearExpenses.forEach(e => {
    const netto = e.amount / (1 + (e.taxRate || 0) / 100);
    totalExpenses += netto;
    totalMwstAusgaben += e.amount - netto;
  });

  const profit = totalRevenue - totalExpenses;
  const ustZahllast = totalMwstEinnahmen - totalMwstAusgaben;

  document.getElementById('fin-revenue').textContent = formatCurrency(totalRevenue);
  document.getElementById('fin-expenses').textContent = formatCurrency(totalExpenses);
  document.getElementById('fin-profit').textContent = formatCurrency(profit);
  document.getElementById('fin-profit').style.color = profit >= 0 ? 'var(--success)' : 'var(--danger)';
  document.getElementById('fin-tax-estimate').textContent = formatCurrency(Math.max(0, ustZahllast));

  // Monatliches Chart
  renderRevenueChart(selectedYear);

  // Überfällige Rechnungen
  renderOverdueInvoices();

  // Top-Kunden
  renderTopCustomers(selectedYear);

  // Ausgaben nach Kategorie
  renderExpenseCategories(selectedYear);
}

function renderRevenueChart(year) {
  const container = document.getElementById('revenue-chart');
  const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

  const monthlyIncome = new Array(12).fill(0);
  const monthlyExpense = new Array(12).fill(0);

  store.invoices.forEach(inv => {
    const d = new Date(inv.date);
    if (d.getFullYear() === year && inv.status === 'bezahlt' && inv.type !== 'gutschrift') {
      const totals = store.calculateInvoiceTotal(inv);
      monthlyIncome[d.getMonth()] += totals.brutto;
    }
  });

  store.expenses.forEach(e => {
    const d = new Date(e.date);
    if (d.getFullYear() === year) {
      monthlyExpense[d.getMonth()] += e.amount;
    }
  });

  const maxVal = Math.max(...monthlyIncome, ...monthlyExpense, 1);

  let html = '';
  for (let i = 0; i < 12; i++) {
    const incPct = (monthlyIncome[i] / maxVal) * 100;
    const expPct = (monthlyExpense[i] / maxVal) * 100;
    html += `
      <div class="chart-bar-row">
        <span class="chart-label">${months[i]}</span>
        <div class="chart-bar-wrap">
          <div class="chart-bar income" style="width:${incPct}%"></div>
        </div>
        <div class="chart-bar-wrap" style="max-width:30%;">
          <div class="chart-bar expense" style="width:${expPct > 0 ? Math.max(expPct, 3) : 0}%"></div>
        </div>
        <span class="chart-bar-value">${formatCurrency(monthlyIncome[i])}</span>
      </div>
    `;
  }

  html += `
    <div class="chart-legend">
      <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--accent)"></span> Einnahmen</div>
      <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--danger)"></span> Ausgaben</div>
    </div>
  `;

  container.innerHTML = html;
}

function renderOverdueInvoices() {
  const tbody = document.getElementById('overdue-tbody');
  const table = document.getElementById('overdue-table');
  const empty = document.getElementById('overdue-empty');
  const today = new Date();

  const overdue = store.invoices.filter(inv => {
    if (inv.status !== 'offen') return false;
    const dueDate = new Date(inv.date);
    dueDate.setDate(dueDate.getDate() + (inv.dueDays || 14));
    return today > dueDate;
  }).map(inv => {
    const dueDate = new Date(inv.date);
    dueDate.setDate(dueDate.getDate() + (inv.dueDays || 14));
    const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
    return { ...inv, dueDate, daysOverdue };
  }).sort((a, b) => b.daysOverdue - a.daysOverdue);

  if (overdue.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  tbody.innerHTML = overdue.map(inv => {
    const customer = store.getCustomer(inv.customerId);
    const totals = store.calculateInvoiceTotal(inv);
    return `<tr>
      <td><strong>${inv.number}</strong></td>
      <td>${customer ? escapeHtml(customer.name) : 'Unbekannt'}</td>
      <td>${formatCurrency(totals.brutto)}</td>
      <td>${formatDate(inv.dueDate.toISOString().split('T')[0])}</td>
      <td><span class="overdue-days">${inv.daysOverdue} Tage</span></td>
      <td>
        <button class="btn btn-small btn-danger" onclick="toggleInvoiceStatus('${inv.id}');renderFinances();" title="Als bezahlt markieren">&#10003; Bezahlt</button>
      </td>
    </tr>`;
  }).join('');
}

function renderTopCustomers(year) {
  const container = document.getElementById('top-customers-list');
  const customerRevenue = {};

  store.invoices.forEach(inv => {
    const d = new Date(inv.date);
    if (d.getFullYear() === year && inv.status === 'bezahlt' && inv.type !== 'gutschrift') {
      const totals = store.calculateInvoiceTotal(inv);
      if (!customerRevenue[inv.customerId]) {
        customerRevenue[inv.customerId] = { total: 0, count: 0 };
      }
      customerRevenue[inv.customerId].total += totals.brutto;
      customerRevenue[inv.customerId].count++;
    }
  });

  const sorted = Object.entries(customerRevenue)
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  if (sorted.length === 0) {
    container.innerHTML = '<p style="color:var(--text-tertiary);padding:16px;">Noch keine Daten vorhanden.</p>';
    return;
  }

  container.innerHTML = sorted.map((item, i) => {
    const customer = store.getCustomer(item.id);
    return `
      <div class="top-customer-row">
        <span class="top-customer-rank">${i + 1}</span>
        <div class="top-customer-info">
          <div class="top-customer-name">${customer ? escapeHtml(customer.name) : 'Unbekannt'}</div>
          <div class="top-customer-count">${item.count} Rechnung${item.count > 1 ? 'en' : ''}</div>
        </div>
        <span class="top-customer-amount">${formatCurrency(item.total)}</span>
      </div>
    `;
  }).join('');
}

function renderExpenseCategories(year) {
  const container = document.getElementById('expense-categories-chart');
  const yearExpenses = store.expenses.filter(e => new Date(e.date).getFullYear() === year);

  const categoryTotals = {};
  yearExpenses.forEach(e => {
    const cat = e.category || 'sonstiges';
    categoryTotals[cat] = (categoryTotals[cat] || 0) + e.amount;
  });

  const total = Object.values(categoryTotals).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    container.innerHTML = '<p style="color:var(--text-tertiary);padding:16px;">Keine Ausgaben in diesem Jahr.</p>';
    return;
  }

  const maxCat = sorted[0][1];
  container.innerHTML = sorted.map(([cat, amount]) => {
    const info = EXPENSE_CATEGORIES[cat] || EXPENSE_CATEGORIES.sonstiges;
    const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
    const barPct = (amount / maxCat) * 100;
    return `
      <div class="category-row">
        <span class="category-icon">${info.icon}</span>
        <div class="category-info">
          <div class="category-name">${info.label}</div>
          <div class="category-bar"><div class="category-bar-fill" style="width:${barPct}%"></div></div>
        </div>
        <span class="category-amount">${formatCurrency(amount)}<span class="category-percent">${pct}%</span></span>
      </div>
    `;
  }).join('');
}

// ==========================
// EÜR EXPORT
// ==========================
async function exportEUR() {
  const year = parseInt(document.getElementById('finance-year').value) || new Date().getFullYear();
  const settings = store.settings;

  // Einnahmen sammeln
  const yearInvoices = store.invoices.filter(inv => {
    const d = new Date(inv.date);
    return d.getFullYear() === year && inv.status === 'bezahlt' && inv.type !== 'gutschrift';
  }).sort((a, b) => new Date(a.date) - new Date(b.date));

  // Ausgaben sammeln
  const yearExpenses = store.expenses.filter(e => new Date(e.date).getFullYear() === year)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  let totalIncome = 0;
  let totalExpense = 0;
  let totalMwstIn = 0;
  let totalMwstOut = 0;

  // PDF erstellen
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([595, 842]); // A4
  let y = 790;
  const margin = 50;
  const pageWidth = 595 - 2 * margin;

  function addText(text, x, yPos, size = 10, bold = false) {
    page.drawText(text, { x, y: yPos, size, font: bold ? fontBold : font, color: rgb(0.1, 0.1, 0.1) });
  }

  function checkNewPage() {
    if (y < 80) {
      page = pdfDoc.addPage([595, 842]);
      y = 790;
    }
  }

  // Header
  addText(`Einnahmen-Überschuss-Rechnung ${year}`, margin, y, 16, true);
  y -= 24;
  if (settings.company.name) {
    addText(settings.company.name, margin, y, 10);
    y -= 14;
  }
  if (settings.company.taxNumber) {
    addText(`Steuernummer: ${settings.company.taxNumber}`, margin, y, 9);
    y -= 14;
  }
  if (settings.company.vatId) {
    addText(`USt-IdNr.: ${settings.company.vatId}`, margin, y, 9);
    y -= 14;
  }
  y -= 20;

  // Einnahmen-Tabelle
  addText('EINNAHMEN', margin, y, 12, true);
  y -= 20;
  addText('Datum', margin, y, 8, true);
  addText('Nr.', margin + 70, y, 8, true);
  addText('Kunde', margin + 140, y, 8, true);
  addText('Netto', margin + 330, y, 8, true);
  addText('MwSt', margin + 400, y, 8, true);
  addText('Brutto', margin + 450, y, 8, true);
  y -= 4;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + pageWidth, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 14;

  for (const inv of yearInvoices) {
    checkNewPage();
    const customer = store.getCustomer(inv.customerId);
    const totals = store.calculateInvoiceTotal(inv);
    totalIncome += totals.netto;
    totalMwstIn += totals.mwst;

    addText(formatDate(inv.date), margin, y, 8);
    addText(inv.number || '', margin + 70, y, 8);
    addText((customer ? customer.name : '').substring(0, 28), margin + 140, y, 8);
    addText(formatCurrency(totals.netto), margin + 320, y, 8);
    addText(formatCurrency(totals.mwst), margin + 390, y, 8);
    addText(formatCurrency(totals.brutto), margin + 445, y, 8);
    y -= 14;
  }

  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + pageWidth, y }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
  y -= 16;
  addText('Summe Einnahmen:', margin, y, 10, true);
  addText(formatCurrency(totalIncome), margin + 320, y, 10, true);
  addText(formatCurrency(totalMwstIn), margin + 390, y, 10, true);
  addText(formatCurrency(totalIncome + totalMwstIn), margin + 445, y, 10, true);
  y -= 30;

  // Ausgaben-Tabelle
  checkNewPage();
  addText('AUSGABEN', margin, y, 12, true);
  y -= 20;
  addText('Datum', margin, y, 8, true);
  addText('Beschreibung', margin + 70, y, 8, true);
  addText('Kategorie', margin + 250, y, 8, true);
  addText('Netto', margin + 370, y, 8, true);
  addText('Brutto', margin + 440, y, 8, true);
  y -= 4;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + pageWidth, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 14;

  for (const exp of yearExpenses) {
    checkNewPage();
    const netto = exp.amount / (1 + (exp.taxRate || 0) / 100);
    const mwst = exp.amount - netto;
    totalExpense += netto;
    totalMwstOut += mwst;

    const catInfo = EXPENSE_CATEGORIES[exp.category] || EXPENSE_CATEGORIES.sonstiges;
    addText(formatDate(exp.date), margin, y, 8);
    addText((exp.description || '').substring(0, 28), margin + 70, y, 8);
    addText(catInfo.label.substring(0, 20), margin + 250, y, 8);
    addText(formatCurrency(netto), margin + 365, y, 8);
    addText(formatCurrency(exp.amount), margin + 435, y, 8);
    y -= 14;
  }

  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + pageWidth, y }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
  y -= 16;
  addText('Summe Ausgaben:', margin, y, 10, true);
  addText(formatCurrency(totalExpense), margin + 365, y, 10, true);
  addText(formatCurrency(totalExpense + totalMwstOut), margin + 435, y, 10, true);
  y -= 40;

  // Zusammenfassung
  checkNewPage();
  addText('ZUSAMMENFASSUNG', margin, y, 12, true);
  y -= 24;
  addText(`Einnahmen (netto):`, margin, y, 10);
  addText(formatCurrency(totalIncome), margin + 350, y, 10, true);
  y -= 16;
  addText(`Ausgaben (netto):`, margin, y, 10);
  addText(`- ${formatCurrency(totalExpense)}`, margin + 350, y, 10, true);
  y -= 6;
  page.drawLine({ start: { x: margin + 300, y }, end: { x: margin + pageWidth, y }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
  y -= 18;
  const profit = totalIncome - totalExpense;
  addText(`Gewinn / Verlust:`, margin, y, 11, true);
  addText(formatCurrency(profit), margin + 350, y, 11, true);
  y -= 24;

  if (settings.taxMode === 'regelbesteuerung') {
    addText(`Vereinnahmte USt:`, margin, y, 10);
    addText(formatCurrency(totalMwstIn), margin + 350, y, 10);
    y -= 16;
    addText(`Gezahlte Vorsteuer:`, margin, y, 10);
    addText(`- ${formatCurrency(totalMwstOut)}`, margin + 350, y, 10);
    y -= 16;
    addText(`USt-Zahllast:`, margin, y, 10, true);
    addText(formatCurrency(totalMwstIn - totalMwstOut), margin + 350, y, 10, true);
  }

  // Speichern
  const pdfBytes = await pdfDoc.save();
  const savedPath = await window.api.savePDF(pdfBytes, `EUER-${year}`);
  if (savedPath) {
    showToast(`EÜR ${year} exportiert`, 'success');
  }
}

function initFinanceYearSelect() {
  const select = document.getElementById('finance-year');
  const currentYear = new Date().getFullYear();
  const years = new Set();
  years.add(currentYear);

  store.invoices.forEach(inv => years.add(new Date(inv.date).getFullYear()));
  store.expenses.forEach(e => years.add(new Date(e.date).getFullYear()));

  const sortedYears = [...years].sort((a, b) => b - a);
  select.innerHTML = sortedYears.map(y => `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`).join('');
}

// ==========================
// MULTI-ORG (Vereine)
// ==========================
function getVisibleOrgs() {
  if (store.userRole === 'admin') {
    return store.allOrgs;
  }
  return store.allOrgs.filter(o => store.userOrgs.includes(o.id));
}

function renderOrgSwitcher() {
  const switcher = document.getElementById('org-switcher');
  const select = document.getElementById('org-select');
  const visibleOrgs = getVisibleOrgs();

  // Member mit nur 1 Org → kein Switcher nötig
  if (visibleOrgs.length <= 1 && store.userRole !== 'admin') {
    switcher.style.display = 'none';
    return;
  }

  switcher.style.display = '';
  let html = '';
  // Nur Admins sehen "Gesamtübersicht"
  if (store.userRole === 'admin') {
    html += `<option value="_all" ${!store.currentOrgId ? 'selected' : ''}>Gesamtübersicht</option>`;
  }
  html += visibleOrgs.map(org =>
    `<option value="${org.id}" ${store.currentOrgId === org.id ? 'selected' : ''}>${escapeHtml(org.name)}</option>`
  ).join('');
  select.innerHTML = html;
}

async function switchOrg(orgId) {
  // Zugriffskontrolle: Member dürfen nur auf ihre Orgs zugreifen
  if (store.userRole !== 'admin') {
    if (orgId === '_all') {
      showToast('Kein Zugriff auf Gesamtübersicht', 'error');
      return;
    }
    if (!store.userOrgs.includes(orgId)) {
      showToast('Kein Zugriff auf diesen Verein', 'error');
      return;
    }
  }

  if (orgId === '_all') {
    // Gesamtübersicht — nur für Admins
    store.stopRealtimeSync();
    store.currentOrgId = null;
    await store.loadSettings();
    await loadAllOrgsData();
    store.startRealtimeSync();
  } else {
    await store.switchOrg(orgId);
  }

  // UI aktualisieren
  loadExpenseCategories();
  renderDashboard();
  renderCustomersList();
  renderExpensesList();
  renderDonationsList();
  await loadTeams();
  renderSettingsForm();
  renderExpenseCategoriesSettings();
  updateInvoiceForm();
  updateNumberPreview();
  initFinanceYearSelect();
  showToast(`Gewechselt zu: ${orgId === '_all' ? 'Gesamtübersicht' : (store.allOrgs.find(o => o.id === orgId) || {}).name || orgId}`, 'success');
}

async function loadAllOrgsData() {
  // Nur Admins dürfen alle Orgs laden
  if (!store.useFirebase || !db || store.userRole !== 'admin') return;

  store.customers = [];
  store.invoices = [];
  store.expenses = [];
  store.donations = [];
  teams = [];

  for (const org of store.allOrgs) {
    try {
      const custs = await db.collection('orgs').doc(org.id).collection('customers').get();
      custs.docs.forEach(doc => store.customers.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));

      const invs = await db.collection('orgs').doc(org.id).collection('invoices').get();
      invs.docs.forEach(doc => store.invoices.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));

      const exps = await db.collection('orgs').doc(org.id).collection('expenses').get();
      exps.docs.forEach(doc => store.expenses.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));

      const dons = await db.collection('orgs').doc(org.id).collection('donations').get();
      dons.docs.forEach(doc => store.donations.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));

      const tms = await db.collection('orgs').doc(org.id).collection('teams').get();
      tms.docs.forEach(doc => teams.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));
    } catch (e) {
      console.warn(`Fehler beim Laden von Org ${org.name}:`, e);
    }
  }
}

// --- Org CRUD (nur Admin) ---
function showOrgForm() {
  if (store.userRole !== 'admin') { showToast('Nur Admins können Vereine erstellen', 'error'); return; }
  document.getElementById('org-modal').classList.add('active');
  document.getElementById('org-name').value = '';
}

function closeOrgModal() {
  document.getElementById('org-modal').classList.remove('active');
}

async function saveOrg() {
  const name = document.getElementById('org-name').value.trim();
  if (!name) {
    showToast('Bitte einen Vereinsnamen eingeben', 'error');
    return;
  }

  const org = await store.createOrg(name);
  if (org) {
    closeOrgModal();
    renderOrgsList();
    renderOrgSwitcher();
    showToast(`Verein "${name}" erstellt`, 'success');
  } else {
    showToast('Fehler beim Erstellen', 'error');
  }
}

async function deleteOrg(orgId) {
  if (store.userRole !== 'admin') { showToast('Nur Admins können Vereine löschen', 'error'); return; }
  const org = store.allOrgs.find(o => o.id === orgId);
  if (!confirm(`Verein "${org ? org.name : ''}" wirklich löschen?\n\nAlle Daten dieses Vereins werden gelöscht!`)) return;

  await store.deleteOrg(orgId);

  // Wenn aktive Org gelöscht → wechseln
  if (store.currentOrgId === orgId) {
    const first = store.allOrgs[0];
    if (first) await store.switchOrg(first.id);
  }

  renderOrgsList();
  renderOrgSwitcher();
  showToast('Verein gelöscht');
}

async function renderOrgsList() {
  const container = document.getElementById('orgs-list');
  if (!container) return;

  await store.loadAllOrgs();
  const allUsers = await store.getAllUsers();

  if (store.allOrgs.length === 0) {
    container.innerHTML = '<p style="color:var(--text-tertiary);padding:20px;">Noch keine Vereine erstellt.</p>';
    return;
  }

  container.innerHTML = store.allOrgs.map(org => {
    const orgUsers = allUsers.filter(u => (u.orgs || []).includes(org.id));
    return `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-light);border-radius:var(--radius-lg);padding:24px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div>
            <h3 style="font-size:18px;font-weight:700;margin:0;">${escapeHtml(org.name)}</h3>
            <span style="font-size:12px;color:var(--text-tertiary);">${orgUsers.length} Mitglied${orgUsers.length !== 1 ? 'er' : ''}</span>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-small" onclick="showInviteCode('${org.id}')">🔗 Einladen</button>
            <button class="btn btn-small" onclick="showMemberForm('${org.id}')">+ Mitglied</button>
            <button class="btn btn-small btn-danger" onclick="deleteOrg('${org.id}')">Löschen</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${orgUsers.length === 0 ? '<p style="color:var(--text-tertiary);font-size:13px;">Noch keine Mitglieder zugewiesen.</p>' :
            orgUsers.map(u => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-tertiary);border-radius:6px;">
                <div>
                  <span style="font-size:13px;font-weight:600;">${escapeHtml(u.email)}</span>
                  <span class="badge" style="margin-left:8px;font-size:10px;padding:2px 8px;${u.role === 'admin' ? 'background:var(--warning-subtle);color:var(--warning);' : 'background:var(--accent-subtle);color:var(--accent);'}">${u.role === 'admin' ? 'Admin' : 'Mitglied'}</span>
                </div>
                ${u.role !== 'admin' ? `<button class="btn-icon" onclick="removeOrgMember('${u.email}','${org.id}')" title="Entfernen" style="color:var(--danger);">✕</button>` : ''}
              </div>
            `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function showMemberForm(orgId) {
  if (store.userRole !== 'admin') { showToast('Nur Admins können Mitglieder verwalten', 'error'); return; }
  document.getElementById('member-org-id').value = orgId;
  document.getElementById('member-email').value = '';
  document.getElementById('member-modal').classList.add('active');
}

function closeMemberModal() {
  document.getElementById('member-modal').classList.remove('active');
}

async function addOrgMember() {
  if (store.userRole !== 'admin') { showToast('Nur Admins können Mitglieder verwalten', 'error'); return; }
  const orgId = document.getElementById('member-org-id').value;
  const email = document.getElementById('member-email').value.trim().toLowerCase();

  if (!email) {
    showToast('Bitte eine E-Mail eingeben', 'error');
    return;
  }

  await store.assignUserToOrg(email, orgId);
  closeMemberModal();
  renderOrgsList();
  showToast(`${email} zum Verein hinzugefügt`, 'success');
}

async function removeOrgMember(email, orgId) {
  if (store.userRole !== 'admin') { showToast('Nur Admins können Mitglieder entfernen', 'error'); return; }
  if (!confirm(`${email} aus dem Verein entfernen?`)) return;
  await store.removeUserFromOrg(email, orgId);
  renderOrgsList();
  showToast('Mitglied entfernt');
}

// --- Einladungssystem ---
function showInviteCode(orgId) {
  if (store.userRole !== 'admin') { showToast('Nur Admins können einladen', 'error'); return; }

  const org = store.allOrgs.find(o => o.id === orgId);
  if (!org) return;

  // Einladungscode = Base64-kodierte Firebase Config + Org-ID
  const config = firebase.app().options;
  const inviteData = {
    c: {
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId,
    },
    o: orgId,
    n: org.name,
  };
  const code = btoa(unescape(encodeURIComponent(JSON.stringify(inviteData))));

  document.getElementById('invite-code').value = code;
  document.getElementById('invite-modal').classList.add('active');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.remove('active');
}

function copyInviteCode() {
  const textarea = document.getElementById('invite-code');
  textarea.select();
  navigator.clipboard.writeText(textarea.value).then(() => {
    showToast('Einladungscode kopiert!', 'success');
  }).catch(() => {
    document.execCommand('copy');
    showToast('Einladungscode kopiert!', 'success');
  });
}

async function joinWithInvite() {
  const errorEl = document.getElementById('invite-error');
  const code = document.getElementById('invite-paste').value.trim();
  errorEl.textContent = '';

  if (!code) {
    showAuthError(errorEl, 'Bitte den Einladungscode einfügen');
    return;
  }

  // Code dekodieren
  let inviteData;
  try {
    inviteData = JSON.parse(decodeURIComponent(escape(atob(code))));
  } catch (e) {
    showAuthError(errorEl, 'Ungültiger Einladungscode – bitte nochmal kopieren');
    return;
  }

  if (!inviteData.c || !inviteData.c.apiKey || !inviteData.c.projectId) {
    showAuthError(errorEl, 'Ungültiger Einladungscode – Daten fehlen');
    return;
  }

  // Firebase verbinden
  const btn = document.querySelector('#invite-paste + .auth-error + .btn-primary') ||
              document.querySelector('.wizard-step.active .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Verbinde...'; }

  try {
    const success = await initFirebase(inviteData.c);
    if (!success) {
      showAuthError(errorEl, 'Firebase Verbindung fehlgeschlagen');
      return;
    }

    // Config speichern
    await window.api.saveFirebaseConfig(inviteData.c);
    store.useFirebase = true;

    // Auth-Listener registrieren (wurde beim Wizard-Flow nicht gesetzt)
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        try {
          document.getElementById('auth-overlay').style.display = 'none';
          await initApp();
        } catch (err) {
          console.error('initApp Fehler:', err);
          showToast('Fehler beim Laden: ' + err.message, 'error');
        }
      } else {
        document.getElementById('auth-overlay').style.display = 'flex';
        showAuthLogin();
      }
    });

    // Org-ID merken für nach der Registrierung
    window._pendingInviteOrgId = inviteData.o;
    window._pendingInviteOrgName = inviteData.n;

    // Wizard ausblenden, Register zeigen
    document.getElementById('setup-wizard').style.display = 'none';
    showAuthRegister();
    showToast(`Einladung für "${inviteData.n || 'Verein'}" angenommen! Erstelle jetzt dein Konto.`, 'success');
  } catch (err) {
    showAuthError(errorEl, 'Fehler: ' + (err.message || 'Unbekannter Fehler'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Beitreten →'; }
  }
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
