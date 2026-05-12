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

  // Firebase automatisch verbinden (Config ist fest eingebaut)
  const ok = await initFirebase(FIREBASE_CONFIG);
  if (ok) store.useFirebase = true;

  // Auth-Flow: Nicht eingeloggt → Login/Register, eingeloggt → App
  if (typeof auth !== 'undefined' && auth) {
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
  } else {
    document.getElementById('auth-overlay').style.display = 'flex';
    showAuthLogin();
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
        const inviteOrgId = window._pendingInviteOrgId;
        await store.assignUserToOrg(auth.currentUser.email, inviteOrgId, 'member');
        store.userOrgs.push(inviteOrgId);
        store.orgRoles[inviteOrgId] = 'member';
        store.currentOrgId = inviteOrgId;
        store.userRole = 'member';
        await db.collection('users').doc(auth.currentUser.email).update({
          orgs: store.userOrgs,
          orgRoles: store.orgRoles,
          lastOrgId: inviteOrgId,
        });
        showToast(`Du bist jetzt Mitglied von "${window._pendingInviteOrgName || 'Verein'}"`, 'success');
      } catch (e) {
        console.warn('Einladung konnte nicht verarbeitet werden:', e);
      }
      window._pendingInviteOrgId = null;
      window._pendingInviteOrgName = null;
    }

    renderOrgSwitcher();

    // Vereine-Tab anzeigen wenn User Admin in mindestens einem Verein ist
    const isAnyAdmin = Object.values(store.orgRoles).includes('admin');
    document.getElementById('nav-orgs').style.display = isAnyAdmin ? '' : 'none';

    // Org zuweisen
    if (!store.currentOrgId && store.userOrgs.length > 0) {
      // User hat Orgs → erste nehmen
      store.currentOrgId = store.userOrgs[0];
    } else if (store.currentOrgId && store.userOrgs.length > 0 && !store.userOrgs.includes(store.currentOrgId)) {
      // Gespeicherte Org nicht mehr zugewiesen → auf erste erlaubte wechseln
      store.currentOrgId = store.userOrgs[0];
    }

    // Kein Verein zugewiesen → neuen erstellen (jeder neue User bekommt seinen eigenen)
    if (!store.currentOrgId && store.userOrgs.length === 0) {
      try {
        const org = await store.createOrg('Mein Verein');
        if (org) {
          store.currentOrgId = org.id;
          store.userOrgs = [org.id];
          store.userRole = 'admin';
          store.orgRoles[org.id] = 'admin';
          await db.collection('users').doc(auth.currentUser.email).update({
            orgs: [org.id],
            orgRoles: store.orgRoles,
            lastOrgId: org.id,
          });
          showToast('Verein "Mein Verein" wurde erstellt. Du kannst ihn unter Vereine umbenennen.', 'info', 5000);
        }
      } catch (e) {
        console.error('Auto-Verein erstellen fehlgeschlagen:', e);
        showToast('Verein konnte nicht erstellt werden: ' + e.message, 'error');
      }
    }
  }

  await store.loadSettings();
  await store.loadCustomers();
  await store.loadInvoices();
  await store.loadExpenses();
  await store.loadDonations();
  await store.loadContacts();
  await store.loadDocuments();
  await store.loadEvents();
  await store.loadShoppingList();
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
    if (type === 'contacts') {
      renderContactsList();
    }
    if (type === 'documents') {
      renderDocumentsList();
    }
    if (type === 'events') {
      renderCalendar();
    }
    if (type === 'shopping') {
      renderShoppingList();
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
  renderContactsList();
  renderDocumentsList();
  renderCalendar();
  renderShoppingList();
  await loadTeams();
  renderSettingsForm();
  renderExpenseCategoriesSettings();
  updateInvoiceForm();
  updateNumberPreview();
  initFinanceYearSelect();

  // Offline/Online-Status überwachen
  setupOfflineIndicator();
}

// --- Offline-Modus ---
let isOnline = navigator.onLine;

function setupOfflineIndicator() {
  // Status-Badge erstellen
  const indicator = document.createElement('div');
  indicator.id = 'connection-status';
  indicator.className = isOnline ? 'connection-online' : 'connection-offline';
  indicator.innerHTML = isOnline
    ? '<span class="status-dot online"></span> Online'
    : '<span class="status-dot offline"></span> Offline';
  document.body.appendChild(indicator);

  // Online/Offline Events
  window.addEventListener('online', () => {
    isOnline = true;
    updateConnectionStatus();
    showToast('Verbindung wiederhergestellt — Daten werden synchronisiert', 'success');
    // Pending Änderungen synchronisieren
    if (store.useFirebase && db) {
      db.enableNetwork().then(() => {
        console.log('Firestore Netzwerk aktiviert');
      }).catch(e => console.warn('enableNetwork fehlgeschlagen:', e));
    }
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    updateConnectionStatus();
    showToast('Keine Internetverbindung — Offline-Modus aktiv', 'warning', 5000);
    // Firestore in Offline-Modus setzen
    if (store.useFirebase && db) {
      db.disableNetwork().then(() => {
        console.log('Firestore Netzwerk deaktiviert (Offline)');
      }).catch(e => console.warn('disableNetwork fehlgeschlagen:', e));
    }
  });

  // Firestore Snapshot-Metadaten überwachen (zeigt pending writes)
  if (store.useFirebase && db && store.currentOrgId) {
    store._col('invoices').onSnapshot({ includeMetadataChanges: true }, (snapshot) => {
      const hasPending = snapshot.metadata.hasPendingWrites;
      const fromCache = snapshot.metadata.fromCache;
      const statusEl = document.getElementById('connection-status');
      if (statusEl) {
        if (hasPending) {
          statusEl.className = 'connection-syncing';
          statusEl.innerHTML = '<span class="status-dot syncing"></span> Synchronisiert...';
        } else if (fromCache && !isOnline) {
          statusEl.className = 'connection-offline';
          statusEl.innerHTML = '<span class="status-dot offline"></span> Offline';
        } else {
          statusEl.className = 'connection-online';
          statusEl.innerHTML = '<span class="status-dot online"></span> Online';
        }
      }
    });
  }
}

function updateConnectionStatus() {
  const statusEl = document.getElementById('connection-status');
  if (!statusEl) return;
  if (isOnline) {
    statusEl.className = 'connection-online';
    statusEl.innerHTML = '<span class="status-dot online"></span> Online';
  } else {
    statusEl.className = 'connection-offline';
    statusEl.innerHTML = '<span class="status-dot offline"></span> Offline';
  }
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
  if (tabName === 'contacts') renderContactsList();
  if (tabName === 'documents') renderDocumentsList();
  if (tabName === 'calendar') renderCalendar();
  if (tabName === 'finances') { initFinanceYearSelect(); renderFinances(); }
  if (tabName === 'new-invoice') updateInvoiceForm();
  if (tabName === 'shopping') renderShoppingList();
  if (tabName === 'orgs') renderOrgsList();
}

// --- Toast (New) ---
function showToast(message, type = '', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toastType = type || 'info';
  const icon = icons[toastType] || icons.info;

  const el = document.createElement('div');
  el.className = `toast-item toast-${toastType}`;
  el.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-text">${message}</span>
    <button class="toast-close" onclick="this.parentElement.classList.replace('show','hiding');setTimeout(()=>this.parentElement.remove(),350)">&times;</button>
    <div class="toast-progress" style="animation-duration:${duration}ms"></div>
  `;
  container.appendChild(el);

  // Trigger animation
  requestAnimationFrame(() => el.classList.add('show'));

  // Auto-remove
  setTimeout(() => {
    if (el.parentElement) {
      el.classList.replace('show', 'hiding');
      setTimeout(() => el.remove(), 350);
    }
  }, duration);
}

// --- Confirm Dialog ---
function showConfirm({ title, message, icon, confirmText, confirmClass, onConfirm }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const iconEl = document.getElementById('confirm-icon');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    iconEl.textContent = icon || '⚠️';
    titleEl.textContent = title || 'Bist du sicher?';
    msgEl.textContent = message || '';
    okBtn.textContent = confirmText || 'Löschen';
    okBtn.className = confirmClass || 'btn-danger';

    function cleanup(result) {
      overlay.classList.remove('active');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === overlay) cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    overlay.classList.add('active');
  });
}

// --- PDF Preview ---
let _pdfPreviewBytes = null;
let _pdfPreviewName = null;

function showPdfPreview(pdfBytes, title, fileName) {
  _pdfPreviewBytes = pdfBytes;
  _pdfPreviewName = fileName;
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  document.getElementById('pdf-preview-title').textContent = title || 'PDF Vorschau';
  document.getElementById('pdf-preview-frame').src = url;
  document.getElementById('pdf-preview-overlay').classList.add('active');
}

function closePdfPreview() {
  const frame = document.getElementById('pdf-preview-frame');
  if (frame.src) URL.revokeObjectURL(frame.src);
  frame.src = '';
  document.getElementById('pdf-preview-overlay').classList.remove('active');
  _pdfPreviewBytes = null;
  _pdfPreviewName = null;
}

async function pdfPreviewSave() {
  if (!_pdfPreviewBytes || !_pdfPreviewName) return;
  const savedPath = await window.api.savePDF(_pdfPreviewBytes, _pdfPreviewName);
  if (savedPath) {
    showToast(`PDF gespeichert: ${savedPath.split('/').pop()}`, 'success');
  }
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
  // Greeting
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend';
  const greetEl = document.getElementById('dash-greeting');
  if (greetEl) greetEl.textContent = greeting;

  const orgName = store.settings && store.settings.company && store.settings.company.name;
  const subtitleEl = document.getElementById('dash-subtitle');
  if (subtitleEl) subtitleEl.textContent = orgName ? `Übersicht — ${orgName}` : 'Hier ist deine Übersicht';

  // Stats
  const invoices = store.invoices;
  const open = invoices.filter((i) => i.status === 'offen').length;
  const paid = invoices.filter((i) => i.status === 'bezahlt').length;

  let revenue = 0;
  invoices.filter((i) => i.status === 'bezahlt').forEach((i) => {
    const totals = store.calculateInvoiceTotal(i);
    revenue += totals.brutto;
  });

  document.getElementById('stat-open').textContent = open;
  document.getElementById('stat-paid').textContent = paid;
  document.getElementById('stat-revenue').textContent = formatCurrency(revenue);

  // Spenden dieses Jahr
  const now = new Date();
  const yearDonations = (store.donations || [])
    .filter(d => new Date(d.date).getFullYear() === now.getFullYear())
    .reduce((s, d) => s + (d.amount || 0), 0);
  const donEl = document.getElementById('stat-dash-donations');
  if (donEl) donEl.textContent = formatCurrency(yearDonations);

  // --- Invoices table ---
  const tbody = document.getElementById('invoices-tbody');
  const empty = document.getElementById('dashboard-empty');
  const table = document.getElementById('invoices-table');

  if (invoices.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
  } else {
    table.style.display = '';
    empty.style.display = 'none';

    const sorted = [...invoices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    tbody.innerHTML = sorted.map((inv) => {
      const totals = store.calculateInvoiceTotal(inv);
      const customer = store.getCustomer(inv.customerId);
      const statusClass = inv.status === 'bezahlt' ? 'badge-paid' : inv.status === 'storniert' ? 'badge-cancelled' : 'badge-open';
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
    }).join('');
  }

  // --- Upcoming Events ---
  const eventsEl = document.getElementById('dash-upcoming-events');
  if (eventsEl) {
    const todayStr = now.toISOString().split('T')[0];
    const upcoming = (store.events || [])
      .filter(e => e.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
      .slice(0, 4);

    if (upcoming.length === 0) {
      eventsEl.innerHTML = '<div class="dash-empty-hint">Keine anstehenden Termine</div>';
    } else {
      eventsEl.innerHTML = upcoming.map(ev => `
        <div class="dash-activity-item">
          <div class="dash-activity-icon"><span class="calendar-event-dot cat-${ev.category || 'sonstiges'}" style="padding:2px 0;background:transparent;color:inherit;font-size:16px;">${ev.category === 'gebet' ? '🕌' : ev.category === 'sitzung' ? '📋' : ev.category === 'veranstaltung' ? '🎉' : ev.category === 'kurs' ? '📖' : ev.category === 'feiertag' ? '🌙' : '📌'}</span></div>
          <div class="dash-activity-info">
            <div class="dash-activity-title">${escapeHtml(ev.title)}</div>
            <div class="dash-activity-meta">${formatDate(ev.date)}${ev.time ? ' · ' + ev.time + ' Uhr' : ''}</div>
          </div>
        </div>
      `).join('');
    }
  }

  // --- Recent Expenses ---
  const expensesEl = document.getElementById('dash-recent-expenses');
  if (expensesEl) {
    const recentExp = [...(store.expenses || [])]
      .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt))
      .slice(0, 4);

    if (recentExp.length === 0) {
      expensesEl.innerHTML = '<div class="dash-empty-hint">Keine Ausgaben erfasst</div>';
    } else {
      expensesEl.innerHTML = recentExp.map(exp => `
        <div class="dash-activity-item">
          <div class="dash-activity-icon">💸</div>
          <div class="dash-activity-info">
            <div class="dash-activity-title">${escapeHtml(exp.description || '—')}</div>
            <div class="dash-activity-meta">${formatDate(exp.date)}</div>
          </div>
          <div class="dash-activity-amount" style="color:var(--danger);">-${formatCurrency(exp.amount)}</div>
        </div>
      `).join('');
    }
  }

  // --- Recent Donations ---
  const donationsEl = document.getElementById('dash-recent-donations');
  if (donationsEl) {
    const recentDon = [...(store.donations || [])]
      .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt))
      .slice(0, 4);

    if (recentDon.length === 0) {
      donationsEl.innerHTML = '<div class="dash-empty-hint">Keine Spenden erfasst</div>';
    } else {
      donationsEl.innerHTML = recentDon.map(don => `
        <div class="dash-activity-item">
          <div class="dash-activity-icon">🤲</div>
          <div class="dash-activity-info">
            <div class="dash-activity-title">${escapeHtml(don.donorName || '—')}</div>
            <div class="dash-activity-meta">${formatDate(don.date)}${don.purpose ? ' · ' + escapeHtml(don.purpose) : ''}</div>
          </div>
          <div class="dash-activity-amount" style="color:var(--success);">+${formatCurrency(don.amount)}</div>
        </div>
      `).join('');
    }
  }
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
  const ok = await showConfirm({ title: 'Rechnung löschen', message: 'Die Rechnung wird unwiderruflich gelöscht.', icon: '🗑️', confirmText: 'Löschen' });
  if (!ok) return;
  await store.deleteInvoice(id);
  renderDashboard();
  showToast('Rechnung gelöscht', 'success');
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

  // Contact form
  document.getElementById('contact-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveContact();
  });

  // Event form
  document.getElementById('event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveEvent();
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

  // Logo + Unterschrift laden
  let logoData = null;
  const logoPath = await window.api.getLogo();
  if (logoPath) logoData = await window.api.readLogoBase64(logoPath);

  let signatureData = null;
  const sigPath = await window.api.getSignature();
  if (sigPath) signatureData = await window.api.readSignatureBase64(sigPath);

  // EPC QR-Code generieren (nur bei Überweisung + IBAN vorhanden)
  let qrData = null;
  if (inv.paymentMethod !== 'bar' && inv.type !== 'gutschrift' && settings.company.iban) {
    try {
      const iban = (settings.company.iban || '').replace(/\s/g, '');
      const bic = (settings.company.bic || '').replace(/\s/g, '');
      const name = (settings.company.name || '').substring(0, 70);
      const amount = totals.brutto.toFixed(2);
      const reference = (inv.number || '').substring(0, 140);

      // EPC QR-Code Format (EPC069-12)
      const epcLines = [
        'BCD',           // Service Tag
        '002',           // Version
        '1',             // Zeichenkodierung (1 = UTF-8)
        'SCT',           // Identifikation (SEPA Credit Transfer)
        bic,             // BIC (optional ab Version 002)
        name,            // Name des Begünstigten
        iban,            // IBAN
        `EUR${amount}`,  // Betrag
        '',              // Zweck (Purpose Code, optional)
        '',              // Strukturierte Referenz (optional)
        reference,       // Unstrukturierter Verwendungszweck
        '',              // Hinweis an den Nutzer (optional)
      ];

      const epcString = epcLines.join('\n');
      qrData = await window.api.generateQRCode(epcString);
    } catch (e) {
      console.warn('QR-Code-Generierung fehlgeschlagen:', e);
    }
  }

  try {
    const pdfBytes = await generateInvoicePDF({
      invoice: inv,
      settings,
      customer,
      totals,
      logoData,
      signatureData,
      qrData,
    });

    // Immer automatisch in OneDrive/Daten-Ordner speichern
    const autoPath = await window.api.saveAutoPDF(pdfBytes, inv.number);

    if (!skipDialog) {
      // PDF-Vorschau anzeigen
      showPdfPreview(pdfBytes, `Rechnung ${inv.number}`, inv.number);
      showToast(`PDF gespeichert: ${inv.number}.pdf`, 'success');
    } else {
      showToast(`PDF gespeichert: ${inv.number}.pdf`, 'success');
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
  const ok = await showConfirm({ title: 'Kunde löschen', message: 'Der Kunde wird unwiderruflich gelöscht.', icon: '🗑️', confirmText: 'Löschen' });
  if (!ok) return;
  await store.deleteCustomer(id);
  renderCustomersList();
  showToast('Kunde gelöscht', 'success');
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

  // User-E-Mail anzeigen
  const userEmailEl = document.getElementById('settings-user-email');
  if (userEmailEl && auth && auth.currentUser) {
    userEmailEl.textContent = `Angemeldet als: ${auth.currentUser.email}`;
  }

  // Firebase-Status
  const fbStatus = document.getElementById('firebase-status');
  if (fbStatus) {
    fbStatus.innerHTML = `<span style="color:var(--success);font-weight:600;">● Verbunden</span>`;
  }

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

  // Logo + Unterschrift
  await renderLogoPreview();
  await renderSignaturePreview();
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

async function renderSignaturePreview() {
  const preview = document.getElementById('signature-preview');
  if (!preview) return;
  const sigPath = await window.api.getSignature();
  if (sigPath) {
    const sigData = await window.api.readSignatureBase64(sigPath);
    if (sigData) {
      preview.innerHTML = `<img src="data:${sigData.mimeType};base64,${sigData.data}" alt="Unterschrift" style="max-height:60px;">`;
      return;
    }
  }
  preview.innerHTML = '<span class="logo-placeholder">Keine Unterschrift</span>';
}

async function uploadSignature() {
  try {
    const result = await window.api.uploadSignature();
    if (result) {
      showToast('Unterschrift hochgeladen', 'success');
      await renderSignaturePreview();
    }
  } catch (err) {
    showToast('Fehler: ' + err.message, 'error');
  }
}

async function removeSignature() {
  await window.api.removeSignature();
  await renderSignaturePreview();
  showToast('Unterschrift entfernt');
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
// AUTH (Firebase Auth)
// ==========================
function showAuthLogin() {
  document.getElementById('auth-login-form').style.display = 'block';
  document.getElementById('auth-register-form').style.display = 'none';
  const priv = document.getElementById('auth-privacy');
  if (priv) priv.style.display = 'none';
  document.getElementById('auth-error').textContent = '';
  setTimeout(() => document.getElementById('auth-email').focus(), 50);
}

function showAuthRegister() {
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-register-form').style.display = 'block';
  const priv = document.getElementById('auth-privacy');
  if (priv) priv.style.display = 'none';
  document.getElementById('auth-reg-error').textContent = '';
  setTimeout(() => document.getElementById('auth-reg-email').focus(), 50);
}

function showPrivacyPolicy(e) {
  if (e) e.preventDefault();
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-register-form').style.display = 'none';
  document.getElementById('auth-privacy').style.display = 'block';
}

function showSettingsPrivacy() {
  const el = document.getElementById('settings-privacy-section');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
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

  // Einladungscode prüfen (optional)
  const inviteCode = document.getElementById('invite-paste').value.trim();
  if (inviteCode) {
    try {
      const inviteData = JSON.parse(decodeURIComponent(escape(atob(inviteCode))));
      if (inviteData.o) {
        window._pendingInviteOrgId = inviteData.o;
        window._pendingInviteOrgName = inviteData.n || 'Verein';
      }
    } catch (e) {
      showAuthError(document.getElementById('invite-error'), 'Ungültiger Einladungscode');
      return;
    }
  }

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
    showAuthError(errorEl, 'Verbindung fehlgeschlagen – bitte App neu starten');
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

  const ok = await showConfirm({ title: 'Gutschrift erstellen', message: `Gutschrift für Rechnung ${inv.number} erstellen?`, icon: '📄', confirmText: 'Erstellen', confirmClass: 'btn btn-primary' });
  if (!ok) return;

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

// Firebase ist jetzt fest eingebaut — connectFirebase/disconnectFirebase nicht mehr nötig

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
  const ok = await showConfirm({ title: 'Ausgabe löschen', message: 'Die Ausgabe wird unwiderruflich gelöscht.', icon: '🗑️', confirmText: 'Löschen' });
  if (!ok) return;
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
  const ok = await showConfirm({ title: 'Spende löschen', message: 'Die Spende wird unwiderruflich gelöscht.', icon: '🗑️', confirmText: 'Löschen' });
  if (!ok) return;
  await store.deleteDonation(id);
  renderDonationsList();
  showToast('Spende gelöscht', 'success');
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

    let signatureData = null;
    const sigPath = await window.api.getSignature();
    if (sigPath) signatureData = await window.api.readSignatureBase64(sigPath);

    const pdfBytes = await generateDonationReceiptPDF({
      donations,
      settings,
      logoData,
      signatureData,
      isSammel: true,
      year,
    });

    const fileName = `Sammelbestätigung_${donor.replace(/[^a-zA-Z0-9äöüÄÖÜß]/g, '_')}_${year}`;
    await window.api.saveAutoPDF(pdfBytes, fileName);
    showPdfPreview(pdfBytes, `Sammelbestätigung — ${donor} (${year})`, fileName);
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

    let signatureData = null;
    const sigPath = await window.api.getSignature();
    if (sigPath) signatureData = await window.api.readSignatureBase64(sigPath);

    const pdfBytes = await generateDonationReceiptPDF({
      donations: [donation],
      settings,
      logoData,
      signatureData,
      isSammel: false,
    });

    const fileName = donation.number || `Spendenquittung_${donation.donorName}`;
    const cleanName = fileName.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '_');
    await window.api.saveAutoPDF(pdfBytes, cleanName);
    showPdfPreview(pdfBytes, `Spendenquittung — ${donation.donorName}`, cleanName);
    showToast('Spendenquittung als PDF gespeichert', 'success');
  } catch (err) {
    console.error('Spendenquittung PDF Fehler:', err);
    showToast('Fehler: ' + err.message, 'error');
  }
}

// ==========================
// KONTAKTBUCH (Contacts)
// ==========================

function showContactForm(editId) {
  const modal = document.getElementById('contact-modal');
  const title = document.getElementById('contact-modal-title');
  document.getElementById('contact-edit-id').value = editId || '';

  if (editId) {
    title.textContent = 'Kontakt bearbeiten';
    const c = store.getContact(editId);
    if (c) {
      document.getElementById('contact-firstname').value = c.firstName || '';
      document.getElementById('contact-lastname').value = c.lastName || '';
      document.getElementById('contact-phone').value = c.phone || '';
      document.getElementById('contact-email').value = c.email || '';
      document.getElementById('contact-address').value = c.address || '';
      document.getElementById('contact-zip').value = c.zip || '';
      document.getElementById('contact-city').value = c.city || '';
      document.getElementById('contact-group').value = c.group || '';
      document.getElementById('contact-notes').value = c.notes || '';
    }
  } else {
    title.textContent = 'Neuer Kontakt';
    document.getElementById('contact-firstname').value = '';
    document.getElementById('contact-lastname').value = '';
    document.getElementById('contact-phone').value = '';
    document.getElementById('contact-email').value = '';
    document.getElementById('contact-address').value = '';
    document.getElementById('contact-zip').value = '';
    document.getElementById('contact-city').value = '';
    document.getElementById('contact-group').value = '';
    document.getElementById('contact-notes').value = '';
  }

  // Gruppen-Datalist aktualisieren
  updateContactGroupsList();
  modal.classList.add('active');
}

function closeContactModal() {
  document.getElementById('contact-modal').classList.remove('active');
}

function updateContactGroupsList() {
  const groups = [...new Set(store.contacts.map(c => c.group).filter(Boolean))].sort();
  const datalist = document.getElementById('contact-groups-list');
  if (datalist) {
    datalist.innerHTML = groups.map(g => `<option value="${escapeHtml(g)}">`).join('');
  }
  // Filter-Dropdown aktualisieren
  const filter = document.getElementById('filter-contact-group');
  if (filter) {
    const current = filter.value;
    filter.innerHTML = '<option value="">Alle Gruppen</option>' +
      groups.map(g => `<option value="${escapeHtml(g)}" ${g === current ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('');
  }
}

async function saveContact() {
  const editId = document.getElementById('contact-edit-id').value;
  const data = {
    firstName: document.getElementById('contact-firstname').value.trim(),
    lastName: document.getElementById('contact-lastname').value.trim(),
    phone: document.getElementById('contact-phone').value.trim(),
    email: document.getElementById('contact-email').value.trim(),
    address: document.getElementById('contact-address').value.trim(),
    zip: document.getElementById('contact-zip').value.trim(),
    city: document.getElementById('contact-city').value.trim(),
    group: document.getElementById('contact-group').value.trim(),
    notes: document.getElementById('contact-notes').value.trim(),
  };

  if (!data.firstName || !data.lastName) {
    showToast('Bitte Vor- und Nachname eingeben', 'error');
    return;
  }

  if (editId) {
    await store.updateContact(editId, data);
    showToast('Kontakt aktualisiert', 'success');
  } else {
    await store.addContact(data);
    showToast('Kontakt gespeichert', 'success');
  }

  closeContactModal();
  renderContactsList();
}

async function deleteContact(id) {
  const ok = await showConfirm({ title: 'Kontakt löschen', message: 'Der Kontakt wird unwiderruflich gelöscht.', icon: '🗑️', confirmText: 'Löschen' });
  if (!ok) return;
  await store.deleteContact(id);
  renderContactsList();
  showToast('Kontakt gelöscht');
}

function renderContactsList() {
  const container = document.getElementById('contacts-list');
  const empty = document.getElementById('contacts-empty');
  if (!container) return;

  const groupFilter = document.getElementById('filter-contact-group').value;
  let contacts = [...store.contacts];

  if (groupFilter) {
    contacts = contacts.filter(c => c.group === groupFilter);
  }

  // Sort alphabetically
  contacts.sort((a, b) => (a.lastName || '').localeCompare(b.lastName || ''));

  updateContactGroupsList();

  if (contacts.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  container.innerHTML = contacts.map(c => {
    const initials = ((c.firstName || '')[0] || '') + ((c.lastName || '')[0] || '');
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ');
    const details = [c.phone, c.email].filter(Boolean).join(' · ');
    const location = [c.zip, c.city].filter(Boolean).join(' ');
    return `
      <div class="contact-card">
        <div class="contact-avatar">${escapeHtml(initials.toUpperCase())}</div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(fullName)}</div>
          <div class="contact-detail">${escapeHtml(details)}</div>
          ${location ? `<div class="contact-detail">${escapeHtml(location)}</div>` : ''}
        </div>
        ${c.group ? `<span class="contact-group-badge">${escapeHtml(c.group)}</span>` : ''}
        <div class="contact-actions">
          <button class="btn-icon" title="Bearbeiten" onclick="showContactForm('${c.id}')">✏️</button>
          <button class="btn-icon" title="Löschen" onclick="deleteContact('${c.id}')">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

function filterContacts() {
  const query = document.getElementById('search-contacts').value.toLowerCase().trim();
  const cards = document.querySelectorAll('.contact-card');
  cards.forEach(card => {
    card.style.display = card.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

// ==========================
// DOKUMENTE (Documents)
// ==========================

async function uploadDocument() {
  const result = await window.api.uploadDocument();
  if (!result) return;

  // Show category modal
  document.getElementById('doc-pending-path').value = result.filePath;
  document.getElementById('doc-pending-name').value = result.fileName;
  document.getElementById('doc-pending-size').value = result.size;
  document.getElementById('doc-display-name').value = result.fileName;
  document.getElementById('doc-description').value = '';
  document.getElementById('doc-category-select').value = 'sonstiges';
  document.getElementById('doc-category-modal').classList.add('active');
}

function closeDocCategoryModal() {
  document.getElementById('doc-category-modal').classList.remove('active');
}

async function confirmDocumentUpload() {
  const filePath = document.getElementById('doc-pending-path').value;
  const fileName = document.getElementById('doc-pending-name').value;
  const size = parseInt(document.getElementById('doc-pending-size').value) || 0;
  const category = document.getElementById('doc-category-select').value;
  const description = document.getElementById('doc-description').value.trim();

  await store.addDocument({
    fileName,
    filePath,
    category,
    description,
    size,
  });

  closeDocCategoryModal();
  renderDocumentsList();
  showToast('Dokument hochgeladen', 'success');
}

async function openDocument(id) {
  const doc = store.documents.find(d => d.id === id);
  if (doc && doc.filePath) {
    await window.api.openDocument(doc.filePath);
  }
}

async function deleteDocument(id) {
  const ok = await showConfirm({ title: 'Dokument löschen', message: 'Das Dokument wird unwiderruflich gelöscht.', icon: '🗑️', confirmText: 'Löschen' });
  if (!ok) return;
  const doc = store.documents.find(d => d.id === id);
  if (doc && doc.filePath) {
    await window.api.deleteDocumentFile(doc.filePath);
  }
  await store.deleteDocument(id);
  renderDocumentsList();
  showToast('Dokument gelöscht');
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

const DOC_CATEGORY_LABELS = {
  satzung: 'Satzung & Ordnungen',
  protokoll: 'Protokolle',
  vertrag: 'Verträge',
  bescheid: 'Bescheide & Behörden',
  sonstiges: 'Sonstiges',
};

function renderDocumentsList() {
  const tbody = document.getElementById('documents-tbody');
  const empty = document.getElementById('documents-empty');
  const table = document.getElementById('documents-table');
  if (!tbody) return;

  const catFilter = document.getElementById('filter-doc-category').value;
  let docs = [...store.documents];

  if (catFilter) {
    docs = docs.filter(d => d.category === catFilter);
  }

  if (docs.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  // Sort by date descending
  docs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  tbody.innerHTML = docs.map(d => {
    const ext = (d.fileName || '').split('.').pop().toLowerCase();
    const icon = ext === 'pdf' ? '📕' : ['doc', 'docx'].includes(ext) ? '📘' : ['xls', 'xlsx'].includes(ext) ? '📗' : ['png', 'jpg', 'jpeg'].includes(ext) ? '🖼️' : '📄';
    return `
      <tr>
        <td><span style="margin-right:6px;">${icon}</span><strong>${escapeHtml(d.fileName)}</strong>${d.description ? `<br><span style="font-size:11px;color:var(--text-tertiary);">${escapeHtml(d.description)}</span>` : ''}</td>
        <td><span class="badge">${DOC_CATEGORY_LABELS[d.category] || d.category || '—'}</span></td>
        <td>${formatDate(d.createdAt)}</td>
        <td>${formatFileSize(d.size || 0)}</td>
        <td>
          <button class="btn-icon" title="Öffnen" onclick="openDocument('${d.id}')">📂</button>
          <button class="btn-icon" title="Löschen" onclick="deleteDocument('${d.id}')">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterDocuments() {
  const query = document.getElementById('search-documents').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#documents-tbody tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

// ==========================
// KALENDER (Calendar)
// ==========================
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let selectedDate = null;

const EVENT_CATEGORY_LABELS = {
  sitzung: 'Sitzung',
  veranstaltung: 'Veranstaltung',
  gebet: 'Gebet',
  kurs: 'Kurs',
  feiertag: 'Feiertag',
  sonstiges: 'Sonstiges',
};

const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const label = document.getElementById('calendar-month-label');
  if (!grid || !label) return;

  label.textContent = `${MONTH_NAMES[calendarMonth]} ${calendarYear}`;

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // First day of month
  const firstDay = new Date(calendarYear, calendarMonth, 1);
  // Monday = 0 ... Sunday = 6
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const daysInPrev = new Date(calendarYear, calendarMonth, 0).getDate();

  let html = '';
  // Header row
  for (const day of DAY_NAMES) {
    html += `<div class="calendar-header-cell">${day}</div>`;
  }

  // Calendar cells
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  for (let i = 0; i < totalCells; i++) {
    let dayNum, dateStr, isOther = false;

    if (i < startDow) {
      // Previous month
      dayNum = daysInPrev - startDow + i + 1;
      const pm = calendarMonth === 0 ? 11 : calendarMonth - 1;
      const py = calendarMonth === 0 ? calendarYear - 1 : calendarYear;
      dateStr = `${py}-${String(pm + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      isOther = true;
    } else if (i >= startDow + daysInMonth) {
      // Next month
      dayNum = i - startDow - daysInMonth + 1;
      const nm = calendarMonth === 11 ? 0 : calendarMonth + 1;
      const ny = calendarMonth === 11 ? calendarYear + 1 : calendarYear;
      dateStr = `${ny}-${String(nm + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      isOther = true;
    } else {
      dayNum = i - startDow + 1;
      dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    }

    const isToday = dateStr === todayStr;
    const isSelected = dateStr === selectedDate;
    const dayEvents = store.events.filter(e => e.date === dateStr);

    let classes = 'calendar-cell';
    if (isOther) classes += ' other-month';
    if (isToday) classes += ' today';
    if (isSelected) classes += ' selected';

    html += `<div class="${classes}" onclick="selectCalendarDay('${dateStr}')">`;
    html += `<div class="calendar-day-number">${dayNum}</div>`;
    for (const ev of dayEvents.slice(0, 3)) {
      html += `<div class="calendar-event-dot cat-${ev.category || 'sonstiges'}">${escapeHtml(ev.title)}</div>`;
    }
    if (dayEvents.length > 3) {
      html += `<div style="font-size:10px;color:var(--text-tertiary);">+${dayEvents.length - 3} mehr</div>`;
    }
    html += '</div>';
  }

  grid.innerHTML = html;

  // Show day detail if selected
  if (selectedDate) {
    showDayDetail(selectedDate);
  }
}

function calendarPrevMonth() {
  calendarMonth--;
  if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
  renderCalendar();
}

function calendarNextMonth() {
  calendarMonth++;
  if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  renderCalendar();
}

function calendarToday() {
  const now = new Date();
  calendarYear = now.getFullYear();
  calendarMonth = now.getMonth();
  selectedDate = now.toISOString().split('T')[0];
  renderCalendar();
}

function selectCalendarDay(dateStr) {
  selectedDate = dateStr;
  renderCalendar();
}

function showDayDetail(dateStr) {
  const detail = document.getElementById('calendar-day-detail');
  const title = document.getElementById('calendar-day-title');
  const container = document.getElementById('calendar-day-events');
  if (!detail) return;

  const dayEvents = store.events.filter(e => e.date === dateStr).sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  const dateObj = new Date(dateStr + 'T12:00:00');
  title.textContent = `Termine am ${dateObj.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;

  if (dayEvents.length === 0) {
    container.innerHTML = '<p style="color:var(--text-tertiary);font-size:13px;padding:8px 0;">Keine Termine an diesem Tag.</p>';
  } else {
    container.innerHTML = dayEvents.map(ev => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-secondary);border-radius:var(--radius);margin-bottom:6px;">
        <div class="calendar-event-dot cat-${ev.category || 'sonstiges'}" style="padding:4px 10px;font-size:12px;">${EVENT_CATEGORY_LABELS[ev.category] || ev.category}</div>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:14px;">${escapeHtml(ev.title)}</div>
          ${ev.description ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(ev.description)}</div>` : ''}
        </div>
        ${ev.time ? `<span style="font-size:13px;color:var(--text-secondary);font-weight:500;">${ev.time} Uhr</span>` : ''}
        <button class="btn-icon" title="Bearbeiten" onclick="showEventForm('${ev.id}')">✏️</button>
        <button class="btn-icon" title="Löschen" onclick="deleteEvent('${ev.id}')">🗑️</button>
      </div>
    `).join('');
  }

  detail.style.display = '';
}

function showEventForm(editId) {
  const modal = document.getElementById('event-modal');
  const title = document.getElementById('event-modal-title');
  document.getElementById('event-edit-id').value = editId || '';

  if (editId) {
    title.textContent = 'Termin bearbeiten';
    const ev = store.getEvent(editId);
    if (ev) {
      document.getElementById('event-title').value = ev.title || '';
      document.getElementById('event-date').value = ev.date || '';
      document.getElementById('event-time').value = ev.time || '';
      document.getElementById('event-category').value = ev.category || 'sonstiges';
      document.getElementById('event-description').value = ev.description || '';
    }
  } else {
    title.textContent = 'Neuer Termin';
    document.getElementById('event-title').value = '';
    document.getElementById('event-date').value = selectedDate || new Date().toISOString().split('T')[0];
    document.getElementById('event-time').value = '';
    document.getElementById('event-category').value = 'sonstiges';
    document.getElementById('event-description').value = '';
  }

  modal.classList.add('active');
}

function closeEventModal() {
  document.getElementById('event-modal').classList.remove('active');
}

async function saveEvent() {
  const editId = document.getElementById('event-edit-id').value;
  const data = {
    title: document.getElementById('event-title').value.trim(),
    date: document.getElementById('event-date').value,
    time: document.getElementById('event-time').value,
    category: document.getElementById('event-category').value,
    description: document.getElementById('event-description').value.trim(),
  };

  if (!data.title || !data.date) {
    showToast('Bitte Titel und Datum eingeben', 'error');
    return;
  }

  if (editId) {
    await store.updateEvent(editId, data);
    showToast('Termin aktualisiert', 'success');
  } else {
    await store.addEvent(data);
    showToast('Termin erstellt', 'success');
  }

  closeEventModal();
  renderCalendar();
}

async function deleteEvent(id) {
  const ok = await showConfirm({ title: 'Termin löschen', message: 'Der Termin wird unwiderruflich gelöscht.', icon: '🗑️', confirmText: 'Löschen' });
  if (!ok) return;
  await store.deleteEvent(id);
  renderCalendar();
  showToast('Termin gelöscht');
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

  const baseUrl = 'https://malikk065.github.io/Zakflow/docs/team.html';
  const orgParam = store.currentOrgId ? `&o=${store.currentOrgId}` : '';
  const url = `${baseUrl}?t=${teamId}${orgParam}`;

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
  const ok = await showConfirm({ title: 'Team löschen', message: `"${team ? team.name : ''}" wird gelöscht. Die Ausgaben bleiben erhalten.`, icon: '👥', confirmText: 'Löschen' });
  if (!ok) return;

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
  // Nur Orgs anzeigen zu denen der User gehört
  return store.allOrgs.filter(o => store.userOrgs.includes(o.id));
}

function renderOrgSwitcher() {
  const switcher = document.getElementById('org-switcher');
  const select = document.getElementById('org-select');
  const visibleOrgs = getVisibleOrgs();

  // Nur 1 Verein → kein Switcher nötig
  if (visibleOrgs.length <= 1) {
    switcher.style.display = 'none';
    return;
  }

  switcher.style.display = '';
  let html = '';
  // Gesamtübersicht nur wenn Admin in mindestens einem Verein
  const isAnyAdmin = Object.values(store.orgRoles).includes('admin');
  if (isAnyAdmin && visibleOrgs.length > 1) {
    html += `<option value="_all" ${!store.currentOrgId ? 'selected' : ''}>Gesamtübersicht</option>`;
  }
  html += visibleOrgs.map(org => {
    const role = store.orgRoles[org.id] || 'member';
    const roleLabel = role === 'admin' ? ' (Admin)' : '';
    return `<option value="${org.id}" ${store.currentOrgId === org.id ? 'selected' : ''}>${escapeHtml(org.name)}${roleLabel}</option>`;
  }).join('');
  select.innerHTML = html;
}

async function switchOrg(orgId) {
  // Zugriffskontrolle
  if (orgId !== '_all' && !store.userOrgs.includes(orgId)) {
    showToast('Kein Zugriff auf diesen Verein', 'error');
    return;
  }
  if (orgId === '_all' && !Object.values(store.orgRoles).includes('admin')) {
    showToast('Kein Zugriff auf Gesamtübersicht', 'error');
    return;
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
  renderContactsList();
  renderDocumentsList();
  renderCalendar();
  renderShoppingList();
  await loadTeams();
  renderSettingsForm();
  renderExpenseCategoriesSettings();
  updateInvoiceForm();
  updateNumberPreview();
  initFinanceYearSelect();
  showToast(`Gewechselt zu: ${orgId === '_all' ? 'Gesamtübersicht' : (store.allOrgs.find(o => o.id === orgId) || {}).name || orgId}`, 'success');
}

async function loadAllOrgsData() {
  // Nur wenn User Zugriff hat
  if (!store.useFirebase || !db) return;

  store.customers = [];
  store.invoices = [];
  store.expenses = [];
  store.donations = [];
  store.contacts = [];
  store.documents = [];
  store.events = [];
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

      const conts = await db.collection('orgs').doc(org.id).collection('contacts').get();
      conts.docs.forEach(doc => store.contacts.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));

      const docs2 = await db.collection('orgs').doc(org.id).collection('documents').get();
      docs2.docs.forEach(doc => store.documents.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));

      const evts = await db.collection('orgs').doc(org.id).collection('events').get();
      evts.docs.forEach(doc => store.events.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));

      const tms = await db.collection('orgs').doc(org.id).collection('teams').get();
      tms.docs.forEach(doc => teams.push({ id: doc.id, ...doc.data(), _orgId: org.id, _orgName: org.name }));
    } catch (e) {
      console.warn(`Fehler beim Laden von Org ${org.name}:`, e);
    }
  }
}

// --- Org CRUD (nur Admin) ---
function showOrgForm() {
  // Jeder darf Vereine erstellen (wird dort Admin)
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

  try {
    const org = await store.createOrg(name);
    if (org) {
      // User als Admin zu dieser Org hinzufügen
      store.userOrgs.push(org.id);
      store.orgRoles[org.id] = 'admin';
      await db.collection('users').doc(auth.currentUser.email).update({
        orgs: store.userOrgs,
        orgRoles: store.orgRoles,
      });
      closeOrgModal();
      await store.loadAllOrgs();
      renderOrgsList();
      renderOrgSwitcher();
      showToast(`Verein "${name}" erstellt`, 'success');
    } else {
      showToast('Fehler beim Erstellen — keine Firebase-Verbindung?', 'error');
    }
  } catch (e) {
    console.error('saveOrg Fehler:', e);
    showToast('Fehler: ' + e.message, 'error');
  }
}

async function deleteOrg(orgId) {
  if (store.orgRoles[orgId] !== 'admin') { showToast('Nur Admins dieses Vereins können ihn löschen', 'error'); return; }
  const org = store.allOrgs.find(o => o.id === orgId);
  const ok = await showConfirm({ title: 'Verein löschen', message: `"${org ? org.name : ''}" und ALLE zugehörigen Daten werden unwiderruflich gelöscht!`, icon: '⚠️', confirmText: 'Endgültig löschen' });
  if (!ok) return;

  await store.deleteOrg(orgId);

  // Aus eigenen Listen entfernen
  store.userOrgs = store.userOrgs.filter(id => id !== orgId);
  delete store.orgRoles[orgId];
  await db.collection('users').doc(auth.currentUser.email).update({
    orgs: store.userOrgs,
    orgRoles: store.orgRoles,
  });

  // Wenn aktive Org gelöscht → wechseln
  if (store.currentOrgId === orgId) {
    const first = store.allOrgs[0];
    if (first) {
      await store.switchOrg(first.id);
    } else {
      store.currentOrgId = null;
    }
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

  const currentEmail = auth && auth.currentUser ? auth.currentUser.email : '';

  container.innerHTML = store.allOrgs.map(org => {
    const orgUsers = allUsers.filter(u => (u.orgs || []).includes(org.id));
    const myRole = store.orgRoles[org.id] || 'member';
    const isAdmin = myRole === 'admin';

    return `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-light);border-radius:var(--radius-lg);padding:24px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div>
            <h3 style="font-size:18px;font-weight:700;margin:0;">${escapeHtml(org.name)}</h3>
            <span style="font-size:12px;color:var(--text-tertiary);">${orgUsers.length} Mitglied${orgUsers.length !== 1 ? 'er' : ''} · Du bist ${isAdmin ? 'Admin' : 'Mitglied'}</span>
          </div>
          ${isAdmin ? `<div style="display:flex;gap:8px;">
            <button class="btn btn-small" onclick="showInviteCode('${org.id}')">🔗 Einladen</button>
            <button class="btn btn-small" onclick="showMemberForm('${org.id}')">+ Mitglied</button>
            <button class="btn btn-small btn-danger" onclick="deleteOrg('${org.id}')">Löschen</button>
          </div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${orgUsers.length === 0 ? '<p style="color:var(--text-tertiary);font-size:13px;">Noch keine Mitglieder zugewiesen.</p>' :
            orgUsers.map(u => {
              const uRole = (u.orgRoles && u.orgRoles[org.id]) || u.role || 'member';
              const isSelf = u.email === currentEmail;
              return `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-tertiary);border-radius:6px;">
                <div>
                  <span style="font-size:13px;font-weight:600;">${escapeHtml(u.email)}${isSelf ? ' (Du)' : ''}</span>
                  <span class="badge" style="margin-left:8px;font-size:10px;padding:2px 8px;${uRole === 'admin' ? 'background:var(--warning-subtle);color:var(--warning);' : 'background:var(--accent-subtle);color:var(--accent);'}">${uRole === 'admin' ? 'Admin' : 'Mitglied'}</span>
                </div>
                <div style="display:flex;gap:4px;">
                  ${isAdmin && !isSelf ? `
                    <button class="btn-icon" onclick="toggleMemberRole('${u.email}','${org.id}','${uRole}')" title="${uRole === 'admin' ? 'Zum Mitglied machen' : 'Zum Admin machen'}" style="font-size:12px;">${uRole === 'admin' ? '👤' : '👑'}</button>
                    <button class="btn-icon" onclick="removeOrgMember('${u.email}','${org.id}')" title="Entfernen" style="color:var(--danger);">✕</button>
                  ` : ''}
                </div>
              </div>`;
            }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function showMemberForm(orgId) {
  if (store.orgRoles[orgId] !== 'admin') { showToast('Nur Admins können Mitglieder verwalten', 'error'); return; }
  document.getElementById('member-org-id').value = orgId;
  document.getElementById('member-email').value = '';
  document.getElementById('member-modal').classList.add('active');
}

function closeMemberModal() {
  document.getElementById('member-modal').classList.remove('active');
}

async function addOrgMember() {
  const orgId = document.getElementById('member-org-id').value;
  if (store.orgRoles[orgId] !== 'admin') { showToast('Nur Admins können Mitglieder verwalten', 'error'); return; }
  const email = document.getElementById('member-email').value.trim().toLowerCase();

  if (!email) {
    showToast('Bitte eine E-Mail eingeben', 'error');
    return;
  }

  await store.assignUserToOrg(email, orgId, 'member');
  closeMemberModal();
  renderOrgsList();
  showToast(`${email} als Mitglied hinzugefügt`, 'success');
}

async function removeOrgMember(email, orgId) {
  if (store.orgRoles[orgId] !== 'admin') { showToast('Nur Admins können Mitglieder entfernen', 'error'); return; }
  const ok = await showConfirm({ title: 'Mitglied entfernen', message: `${email} aus dem Verein entfernen?`, icon: '👤', confirmText: 'Entfernen' });
  if (!ok) return;
  await store.removeUserFromOrg(email, orgId);
  renderOrgsList();
  showToast('Mitglied entfernt', 'success');
}

async function toggleMemberRole(email, orgId, currentRole) {
  if (store.orgRoles[orgId] !== 'admin') { showToast('Nur Admins können Rollen ändern', 'error'); return; }
  const newRole = currentRole === 'admin' ? 'member' : 'admin';
  const label = newRole === 'admin' ? 'zum Admin' : 'zum Mitglied';
  const ok = await showConfirm({ title: 'Rolle ändern', message: `${email} ${label} machen?`, icon: newRole === 'admin' ? '👑' : '👤', confirmText: 'Ändern' });
  if (!ok) return;
  await store.setUserRole(email, orgId, newRole);
  renderOrgsList();
  showToast(`${email} ist jetzt ${newRole === 'admin' ? 'Admin' : 'Mitglied'}`, 'success');
}

// --- Einladungssystem ---
function showInviteCode(orgId) {
  if (store.orgRoles[orgId] !== 'admin') { showToast('Nur Admins können einladen', 'error'); return; }

  const org = store.allOrgs.find(o => o.id === orgId);
  if (!org) return;

  // Einladungscode: nur Org-ID + Name (Firebase Config ist fest eingebaut)
  const inviteData = { o: orgId, n: org.name };
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

// joinWithInvite wird nicht mehr benötigt — Einladungscode wird direkt bei der Registrierung verarbeitet

// ==========================
// BRIEFPAPIER (Letterhead)
// ==========================
function showLetterModal() {
  document.getElementById('letter-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('letter-recipient').value = '';
  document.getElementById('letter-subject').value = '';
  document.getElementById('letter-body').value = '';
  document.getElementById('letter-modal').classList.add('active');
}

function closeLetterModal() {
  document.getElementById('letter-modal').classList.remove('active');
}

async function generateLetter(e) {
  e.preventDefault();

  const recipient = document.getElementById('letter-recipient').value.trim();
  const subject = document.getElementById('letter-subject').value.trim();
  const dateRaw = document.getElementById('letter-date').value;
  const body = document.getElementById('letter-body').value;

  if (!subject && !body) {
    showToast('Bitte mindestens Betreff oder Text eingeben', 'error');
    return;
  }

  const settings = store.settings || {};

  // Datum formatieren
  const date = dateRaw ? new Date(dateRaw).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }) : '';

  // Logo + Unterschrift laden
  let logoData = null;
  const logoPath = await window.api.getLogo();
  if (logoPath) logoData = await window.api.readLogoBase64(logoPath);

  let signatureData = null;
  const sigPath = await window.api.getSignature();
  if (sigPath) signatureData = await window.api.readSignatureBase64(sigPath);

  try {
    const pdfBytes = await generateLetterPDF({
      settings,
      logoData,
      signatureData,
      recipient,
      subject,
      date,
      body,
    });

    const fileName = subject ? `Brief_${subject.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '_').substring(0, 40)}` : 'Briefpapier';
    await window.api.saveAutoPDF(pdfBytes, fileName);
    showPdfPreview(pdfBytes, `Brief — ${subject || 'Briefpapier'}`, fileName);
    showToast('Brief als PDF erstellt', 'success');
    closeLetterModal();
  } catch (err) {
    console.error('Brief PDF Fehler:', err);
    showToast('Fehler: ' + err.message, 'error');
  }
}

// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==========================
// EINKAUFSLISTE
// ==========================
let shoppingFilter = 'all';

const SHOPPING_CATEGORIES = {
  lebensmittel: { label: 'Lebensmittel', icon: '🍎' },
  getraenke: { label: 'Getränke', icon: '🥤' },
  haushalt: { label: 'Haushalt', icon: '🧹' },
  buero: { label: 'Büro', icon: '📎' },
  drogerie: { label: 'Drogerie', icon: '🧴' },
  technik: { label: 'Technik', icon: '💻' },
  sonstiges: { label: 'Sonstiges', icon: '📦' },
};

function showAddShoppingItem() {
  const quickAdd = document.getElementById('shopping-quick-add');
  quickAdd.style.display = quickAdd.style.display === 'none' ? '' : 'none';
  if (quickAdd.style.display !== 'none') {
    document.getElementById('shopping-item-name').focus();
  }
}

async function addShoppingItem() {
  const name = document.getElementById('shopping-item-name').value.trim();
  if (!name) {
    showToast('Bitte einen Artikel eingeben', 'error');
    return;
  }

  const qty = document.getElementById('shopping-item-qty').value.trim();
  const category = document.getElementById('shopping-item-category').value;
  const date = document.getElementById('shopping-item-date').value;

  await store.addShoppingItem({
    name,
    quantity: qty,
    category,
    date: date || '',
  });

  // Felder zurücksetzen
  document.getElementById('shopping-item-name').value = '';
  document.getElementById('shopping-item-qty').value = '';
  document.getElementById('shopping-item-name').focus();

  renderShoppingList();
}

async function toggleShoppingItem(id) {
  const item = store.shoppingList.find(i => i.id === id);
  if (!item) return;
  await store.updateShoppingItem(id, { done: !item.done });
  renderShoppingList();
}

async function deleteShoppingItem(id) {
  await store.deleteShoppingItem(id);
  renderShoppingList();
}

async function clearCompletedItems() {
  const completed = store.shoppingList.filter(i => i.done);
  if (completed.length === 0) {
    showToast('Keine erledigten Einträge vorhanden', 'info');
    return;
  }
  const ok = await showConfirm({
    title: 'Erledigte entfernen',
    message: `${completed.length} erledigte${completed.length === 1 ? 'n' : ''} Einträge entfernen?`,
    icon: '🗑️',
    confirmText: 'Entfernen',
  });
  if (!ok) return;
  await store.clearCompletedShopping();
  renderShoppingList();
  showToast(`${completed.length} Einträge entfernt`, 'success');
}

function filterShoppingDay(day) {
  shoppingFilter = day;
  document.querySelectorAll('.shopping-day-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.day === day);
  });
  renderShoppingList();
}

function getFilteredShoppingList() {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  return store.shoppingList.filter(item => {
    if (shoppingFilter === 'all') return true;
    if (shoppingFilter === 'today') return item.date === today;
    if (shoppingFilter === 'tomorrow') return item.date === tomorrow;
    if (shoppingFilter === 'week') return item.date >= today && item.date <= weekEnd;
    if (shoppingFilter === 'nodate') return !item.date;
    return true;
  });
}

function renderShoppingList() {
  const container = document.getElementById('shopping-list');
  const empty = document.getElementById('shopping-empty');
  if (!container) return;

  const items = getFilteredShoppingList();

  if (items.length === 0) {
    container.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  // Gruppieren nach Datum
  const groups = {};
  for (const item of items) {
    const key = item.date || '_nodate';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  // Sortierung: Heute zuerst, dann chronologisch, "ohne Datum" am Ende
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === '_nodate') return 1;
    if (b === '_nodate') return -1;
    return a.localeCompare(b);
  });

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  container.innerHTML = sortedKeys.map(key => {
    let dayLabel = 'Ohne Datum';
    if (key !== '_nodate') {
      if (key === today) dayLabel = '📌 Heute';
      else if (key === tomorrow) dayLabel = '📅 Morgen';
      else {
        const d = new Date(key);
        const weekday = d.toLocaleDateString('de-DE', { weekday: 'long' });
        dayLabel = `${weekday}, ${d.toLocaleDateString('de-DE')}`;
      }
    }

    const groupItems = groups[key];
    const doneCount = groupItems.filter(i => i.done).length;
    const totalCount = groupItems.length;

    return `
      <div class="shopping-group">
        <div class="shopping-group-header">
          <span class="shopping-group-title">${dayLabel}</span>
          <span class="shopping-group-count">${doneCount}/${totalCount}</span>
        </div>
        <div class="shopping-group-items">
          ${groupItems.map(item => {
            const cat = SHOPPING_CATEGORIES[item.category];
            const catIcon = cat ? cat.icon : '';
            return `
            <div class="shopping-item ${item.done ? 'done' : ''}" onclick="toggleShoppingItem('${item.id}')">
              <div class="shopping-checkbox ${item.done ? 'checked' : ''}">
                ${item.done ? '✓' : ''}
              </div>
              <div class="shopping-item-info">
                <span class="shopping-item-name">${catIcon ? catIcon + ' ' : ''}${escapeHtml(item.name)}</span>
                ${item.quantity ? `<span class="shopping-item-qty">${escapeHtml(item.quantity)}</span>` : ''}
              </div>
              <button class="btn-icon shopping-delete" onclick="event.stopPropagation();deleteShoppingItem('${item.id}')" title="Löschen">✕</button>
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}
