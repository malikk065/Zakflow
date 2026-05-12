// Store - Datenverwaltung über Firebase (mit lokalem Fallback)

class Store {
  constructor() {
    this.settings = null;
    this.customers = [];
    this.invoices = [];
    this.expenses = [];
    this.donations = [];
    this.contacts = [];
    this.documents = [];
    this.events = [];
    this.useFirebase = false;
    this.isElectron = typeof window.api !== 'undefined';
    this._listeners = [];
    this.onDataChanged = null;

    // Multi-Org
    this.currentOrgId = null;  // aktive Organisation
    this.userOrgs = [];        // Orgs zu denen der User gehört
    this.userRole = null;      // 'admin' oder 'member' (im aktuellen Verein)
    this.orgRoles = {};        // Rolle pro Verein: { orgId: 'admin'|'member' }
    this.allOrgs = [];         // Alle Orgs des Users
  }

  // --- Org-Scoped Collection Helpers ---
  _col(name) {
    // Wenn orgId gesetzt, Subcollection unter org verwenden
    if (this.currentOrgId && this.useFirebase) {
      return db.collection('orgs').doc(this.currentOrgId).collection(name);
    }
    // Fallback: root collection (Kompatibilität)
    return db.collection(name);
  }

  _settingsDoc() {
    if (this.currentOrgId && this.useFirebase) {
      return db.collection('orgs').doc(this.currentOrgId).collection('app').doc('settings');
    }
    return db.collection('app').doc('settings');
  }

  // --- Multi-Org Management ---
  async loadUserProfile(email) {
    if (!this.useFirebase || !db) return;

    try {
      const userDoc = await db.collection('users').doc(email).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        this.userOrgs = data.orgs || [];
        this.orgRoles = data.orgRoles || {};
        this.currentOrgId = data.lastOrgId || (this.userOrgs.length > 0 ? this.userOrgs[0] : null);

        // Migration: alte globale Rolle → orgRoles
        if (data.role && Object.keys(this.orgRoles).length === 0) {
          for (const orgId of this.userOrgs) {
            this.orgRoles[orgId] = data.role;
          }
          await db.collection('users').doc(email).update({ orgRoles: this.orgRoles });
        }

        // Aktuelle Rolle = Rolle im aktiven Verein
        this.userRole = this.currentOrgId ? (this.orgRoles[this.currentOrgId] || 'member') : 'admin';
      } else {
        // Neuer User → Admin (erstellt gleich seinen eigenen Verein)
        this.userRole = 'admin';
        this.userOrgs = [];
        this.orgRoles = {};
        this.currentOrgId = null;

        await db.collection('users').doc(email).set({
          email,
          orgs: this.userOrgs,
          orgRoles: this.orgRoles,
          createdAt: new Date().toISOString(),
        });
      }

      // Alle Orgs laden (nur eigene)
      await this.loadAllOrgs();
    } catch (e) {
      console.warn('User profile load failed:', e);
    }
  }

  async loadAllOrgs() {
    if (!this.useFirebase || !db) return;
    try {
      if (this.userOrgs.length > 0) {
        // Nur Orgs laden zu denen der User gehört
        // Firestore 'in' Query max 30 IDs
        const chunks = [];
        for (let i = 0; i < this.userOrgs.length; i += 30) {
          chunks.push(this.userOrgs.slice(i, i + 30));
        }
        this.allOrgs = [];
        for (const chunk of chunks) {
          const snapshot = await db.collection('orgs').where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
          this.allOrgs.push(...snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }
      } else {
        this.allOrgs = [];
      }
    } catch (e) {
      console.warn('Orgs load failed:', e);
    }
  }

  async createOrg(name) {
    if (!this.useFirebase || !db) return null;

    const org = {
      name,
      createdAt: new Date().toISOString(),
    };

    try {
      const docRef = await db.collection('orgs').add(org);
      org.id = docRef.id;
      this.allOrgs.push(org);

      // User wird Admin dieser neuen Org
      this.orgRoles[org.id] = 'admin';

      // Default-Settings für die Org erstellen
      await db.collection('orgs').doc(org.id).collection('app').doc('settings').set(this.defaultSettings());

      return org;
    } catch (e) {
      console.warn('Org create failed:', e);
      return null;
    }
  }

  async deleteOrg(orgId) {
    if (!this.useFirebase || !db) return;
    try {
      await db.collection('orgs').doc(orgId).delete();
      this.allOrgs = this.allOrgs.filter(o => o.id !== orgId);

      // User die diese Org hatten updaten
      const usersSnapshot = await db.collection('users').where('orgs', 'array-contains', orgId).get();
      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        const updatedOrgs = (userData.orgs || []).filter(id => id !== orgId);
        await db.collection('users').doc(userDoc.id).update({ orgs: updatedOrgs });
      }
    } catch (e) {
      console.warn('Org delete failed:', e);
    }
  }

  async switchOrg(orgId) {
    this.stopRealtimeSync();
    this.currentOrgId = orgId;
    this.userRole = this.orgRoles[orgId] || 'member';

    // lastOrgId speichern
    if (auth && auth.currentUser) {
      try {
        await db.collection('users').doc(auth.currentUser.email).update({ lastOrgId: orgId });
      } catch (e) {}
    }

    // Daten neu laden
    await this.loadSettings();
    await this.loadCustomers();
    await this.loadInvoices();
    await this.loadExpenses();
    await this.loadDonations();
    await this.loadContacts();
    await this.loadDocuments();
    await this.loadEvents();
    this.startRealtimeSync();
  }

  async assignUserToOrg(email, orgId, role = 'member') {
    if (!this.useFirebase || !db) return;
    try {
      const userDoc = await db.collection('users').doc(email).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        const orgs = data.orgs || [];
        const orgRoles = data.orgRoles || {};
        if (!orgs.includes(orgId)) {
          orgs.push(orgId);
          orgRoles[orgId] = role;
          await db.collection('users').doc(email).update({ orgs, orgRoles });
        }
      } else {
        // Neuen User-Eintrag anlegen (User hat sich noch nicht registriert)
        await db.collection('users').doc(email).set({
          email,
          orgs: [orgId],
          orgRoles: { [orgId]: role },
          createdAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn('User assign failed:', e);
    }
  }

  async removeUserFromOrg(email, orgId) {
    if (!this.useFirebase || !db) return;
    try {
      const userDoc = await db.collection('users').doc(email).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        const orgs = (data.orgs || []).filter(id => id !== orgId);
        const orgRoles = data.orgRoles || {};
        delete orgRoles[orgId];
        await db.collection('users').doc(email).update({ orgs, orgRoles });
      }
    } catch (e) {
      console.warn('User remove failed:', e);
    }
  }

  async setUserRole(email, orgId, role) {
    if (!this.useFirebase || !db) return;
    try {
      const userDoc = await db.collection('users').doc(email).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        const orgRoles = data.orgRoles || {};
        orgRoles[orgId] = role;
        await db.collection('users').doc(email).update({ orgRoles });
      }
    } catch (e) {
      console.warn('Role set failed:', e);
    }
  }

  async getAllUsers() {
    if (!this.useFirebase || !db) return [];
    try {
      const snapshot = await db.collection('users').get();
      return snapshot.docs.map(doc => ({ email: doc.id, ...doc.data() }));
    } catch (e) { return []; }
  }

  // --- Echtzeit-Listener starten ---
  startRealtimeSync() {
    if (!this.useFirebase) return;

    // Helper: Listener mit lokalem Backup
    const listenAndBackup = (colName, prop, saveFn) => {
      const unsub = this._col(colName).onSnapshot(snapshot => {
        this[prop] = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Lokales Backup speichern (für harten Offline-Fall)
        if (this.isElectron && saveFn) {
          saveFn(this[prop]).catch(() => {});
        }
        if (this.onDataChanged) this.onDataChanged(colName);
      }, err => console.warn(`${colName}-Listener Fehler:`, err));
      this._listeners.push(unsub);
    };

    listenAndBackup('customers', 'customers', d => window.api.saveCustomers(d));
    listenAndBackup('invoices', 'invoices', d => window.api.saveInvoices(d));
    listenAndBackup('expenses', 'expenses', d => window.api.saveExpenses(d));
    listenAndBackup('donations', 'donations', d => window.api.saveDonations(d));
    listenAndBackup('contacts', 'contacts', d => window.api.saveContacts(d));
    listenAndBackup('documents', 'documents', d => window.api.saveDocuments(d));
    listenAndBackup('events', 'events', d => window.api.saveEvents(d));

    // Settings-Listener (speziell, da kein Collection sondern einzelnes Doc)
    const unsubSettings = this._settingsDoc().onSnapshot(doc => {
      if (doc.exists) {
        this.settings = doc.data();
        if (this.isElectron) {
          window.api.saveSettings(this.settings).catch(() => {});
        }
        if (this.onDataChanged) this.onDataChanged('settings');
      }
    }, err => console.warn('Settings-Listener Fehler:', err));
    this._listeners.push(unsubSettings);

    console.log('Echtzeit-Sync gestartet' + (this.currentOrgId ? ` (Org: ${this.currentOrgId})` : ''));
  }

  stopRealtimeSync() {
    this._listeners.forEach(unsub => unsub());
    this._listeners = [];
  }

  // --- Settings ---
  async loadSettings() {
    if (this.useFirebase) {
      try {
        const doc = await this._settingsDoc().get();
        if (doc.exists) {
          this.settings = doc.data();
          return this.settings;
        }
      } catch (e) { console.warn('Firebase settings load failed:', e); }
    }

    if (this.isElectron) {
      this.settings = await window.api.getSettings();
    }

    if (!this.settings) {
      this.settings = this.defaultSettings();
    }
    return this.settings;
  }

  async saveSettings(settings) {
    this.settings = settings;

    if (this.useFirebase) {
      try {
        await this._settingsDoc().set(settings);
      } catch (e) { console.warn('Firebase settings save failed:', e); }
    }

    if (this.isElectron) {
      await window.api.saveSettings(settings);
    }
  }

  defaultSettings() {
    return {
      company: {
        name: '', address: '', zip: '', city: '',
        phone: '', email: '', website: '',
        taxNumber: '', vatId: '',
        bankName: '', iban: '', bic: '',
      },
      taxMode: 'kleinunternehmer',
      invoicePrefix: 'RE',
      nextInvoiceNumber: 1,
      logoPath: '',
    };
  }

  // --- Customers ---
  async loadCustomers() {
    if (this.useFirebase) {
      try {
        const snapshot = await this._col('customers').get();
        if (!snapshot.empty) {
          this.customers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          return this.customers;
        }
      } catch (e) { console.warn('Firebase customers load failed:', e); }
    }

    if (this.isElectron) {
      this.customers = await window.api.getCustomers();
    }
    return this.customers;
  }

  async saveCustomers() {
    if (this.isElectron) {
      await window.api.saveCustomers(this.customers);
    }
  }

  async addCustomer(customer) {
    customer.id = this.generateId();
    customer.createdAt = new Date().toISOString();
    this.customers.push(customer);

    if (this.useFirebase) {
      try {
        await this._col('customers').doc(customer.id).set(customer);
      } catch (e) { console.warn('Firebase customer add failed:', e); }
    }

    if (this.isElectron) await this.saveCustomers();
    return customer;
  }

  async updateCustomer(id, data) {
    const index = this.customers.findIndex(c => c.id === id);
    if (index !== -1) {
      this.customers[index] = { ...this.customers[index], ...data };

      if (this.useFirebase) {
        try {
          await this._col('customers').doc(id).update(data);
        } catch (e) { console.warn('Firebase customer update failed:', e); }
      }

      if (this.isElectron) await this.saveCustomers();
      return this.customers[index];
    }
    return null;
  }

  async deleteCustomer(id) {
    this.customers = this.customers.filter(c => c.id !== id);

    if (this.useFirebase) {
      try {
        await this._col('customers').doc(id).delete();
      } catch (e) { console.warn('Firebase customer delete failed:', e); }
    }

    if (this.isElectron) await this.saveCustomers();
  }

  getCustomer(id) {
    return this.customers.find(c => c.id === id) || null;
  }

  // --- Invoices ---
  async loadInvoices() {
    if (this.useFirebase) {
      try {
        const snapshot = await this._col('invoices').get();
        if (!snapshot.empty) {
          this.invoices = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          return this.invoices;
        }
      } catch (e) { console.warn('Firebase invoices load failed:', e); }
    }

    if (this.isElectron) {
      this.invoices = await window.api.getInvoices();
    }
    return this.invoices;
  }

  async saveInvoices() {
    if (this.isElectron) {
      await window.api.saveInvoices(this.invoices);
    }
  }

  async getNextInvoiceNumber() {
    const settings = await this.loadSettings();
    const year = new Date().getFullYear();
    const num = String(settings.nextInvoiceNumber || 1).padStart(3, '0');
    return `${settings.invoicePrefix || 'RE'}-${year}-${num}`;
  }

  async incrementInvoiceNumber() {
    const settings = await this.loadSettings();
    settings.nextInvoiceNumber = (settings.nextInvoiceNumber || 1) + 1;
    await this.saveSettings(settings);
  }

  async addInvoice(invoice) {
    invoice.id = this.generateId();
    invoice.createdAt = new Date().toISOString();
    invoice.number = await this.getNextInvoiceNumber();
    invoice.status = invoice.status || 'offen';
    this.invoices.push(invoice);

    if (this.useFirebase) {
      try {
        await this._col('invoices').doc(invoice.id).set(invoice);
      } catch (e) { console.warn('Firebase invoice add failed:', e); }
    }

    if (this.isElectron) await this.saveInvoices();
    await this.incrementInvoiceNumber();
    return invoice;
  }

  async updateInvoice(id, data) {
    const index = this.invoices.findIndex(inv => inv.id === id);
    if (index !== -1) {
      this.invoices[index] = { ...this.invoices[index], ...data };

      if (this.useFirebase) {
        try {
          await this._col('invoices').doc(id).update(data);
        } catch (e) { console.warn('Firebase invoice update failed:', e); }
      }

      if (this.isElectron) await this.saveInvoices();
      return this.invoices[index];
    }
    return null;
  }

  async deleteInvoice(id) {
    this.invoices = this.invoices.filter(inv => inv.id !== id);

    if (this.useFirebase) {
      try {
        await this._col('invoices').doc(id).delete();
      } catch (e) { console.warn('Firebase invoice delete failed:', e); }
    }

    if (this.isElectron) await this.saveInvoices();
  }

  getInvoice(id) {
    return this.invoices.find(inv => inv.id === id) || null;
  }

  // --- Expenses ---
  async loadExpenses() {
    if (this.useFirebase) {
      try {
        const snapshot = await this._col('expenses').get();
        if (!snapshot.empty) {
          this.expenses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          return this.expenses;
        }
      } catch (e) { console.warn('Firebase expenses load failed:', e); }
    }

    if (this.isElectron) {
      this.expenses = await window.api.getExpenses();
    }
    return this.expenses;
  }

  async saveExpenses() {
    if (this.isElectron) {
      await window.api.saveExpenses(this.expenses);
    }
  }

  async addExpense(expense) {
    expense.id = this.generateId();
    expense.createdAt = new Date().toISOString();
    this.expenses.push(expense);

    if (this.useFirebase) {
      try {
        await this._col('expenses').doc(expense.id).set(expense);
      } catch (e) { console.warn('Firebase expense add failed:', e); }
    }

    if (this.isElectron) await this.saveExpenses();
    return expense;
  }

  async updateExpense(id, data) {
    const index = this.expenses.findIndex(e => e.id === id);
    if (index !== -1) {
      this.expenses[index] = { ...this.expenses[index], ...data };

      if (this.useFirebase) {
        try {
          await this._col('expenses').doc(id).update(data);
        } catch (e) { console.warn('Firebase expense update failed:', e); }
      }

      if (this.isElectron) await this.saveExpenses();
      return this.expenses[index];
    }
    return null;
  }

  async deleteExpense(id) {
    this.expenses = this.expenses.filter(e => e.id !== id);

    if (this.useFirebase) {
      try {
        await this._col('expenses').doc(id).delete();
      } catch (e) { console.warn('Firebase expense delete failed:', e); }
    }

    if (this.isElectron) await this.saveExpenses();
  }

  getExpense(id) {
    return this.expenses.find(e => e.id === id) || null;
  }

  // --- Spenden (Donations) ---
  async loadDonations() {
    if (this.useFirebase) {
      try {
        const snapshot = await this._col('donations').get();
        if (!snapshot.empty) {
          this.donations = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          return this.donations;
        }
      } catch (e) { console.warn('Firebase donations load failed:', e); }
    }

    if (this.isElectron) {
      this.donations = await window.api.getDonations();
    }
    return this.donations;
  }

  async saveDonations() {
    if (this.isElectron) {
      await window.api.saveDonations(this.donations);
    }
  }

  async addDonation(donation) {
    donation.id = this.generateId();
    donation.createdAt = new Date().toISOString();
    this.donations.push(donation);

    if (this.useFirebase) {
      try {
        await this._col('donations').doc(donation.id).set(donation);
      } catch (e) { console.warn('Firebase donation add failed:', e); }
    }

    if (this.isElectron) await this.saveDonations();
    return donation;
  }

  async updateDonation(id, data) {
    const index = this.donations.findIndex(d => d.id === id);
    if (index !== -1) {
      this.donations[index] = { ...this.donations[index], ...data };

      if (this.useFirebase) {
        try {
          await this._col('donations').doc(id).update(data);
        } catch (e) { console.warn('Firebase donation update failed:', e); }
      }

      if (this.isElectron) await this.saveDonations();
      return this.donations[index];
    }
    return null;
  }

  async deleteDonation(id) {
    this.donations = this.donations.filter(d => d.id !== id);

    if (this.useFirebase) {
      try {
        await this._col('donations').doc(id).delete();
      } catch (e) { console.warn('Firebase donation delete failed:', e); }
    }

    if (this.isElectron) await this.saveDonations();
  }

  getDonation(id) {
    return this.donations.find(d => d.id === id) || null;
  }

  // --- Kontakte (Contacts) ---
  async loadContacts() {
    if (this.useFirebase) {
      try {
        const snapshot = await this._col('contacts').get();
        if (!snapshot.empty) {
          this.contacts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          return this.contacts;
        }
      } catch (e) { console.warn('Firebase contacts load failed:', e); }
    }
    if (this.isElectron) {
      this.contacts = await window.api.getContacts();
    }
    return this.contacts;
  }

  async saveContacts() {
    if (this.isElectron) await window.api.saveContacts(this.contacts);
  }

  async addContact(contact) {
    contact.id = this.generateId();
    contact.createdAt = new Date().toISOString();
    this.contacts.push(contact);
    if (this.useFirebase) {
      try { await this._col('contacts').doc(contact.id).set(contact); } catch (e) { console.warn('Firebase contact add failed:', e); }
    }
    if (this.isElectron) await this.saveContacts();
    return contact;
  }

  async updateContact(id, data) {
    const index = this.contacts.findIndex(c => c.id === id);
    if (index !== -1) {
      this.contacts[index] = { ...this.contacts[index], ...data };
      if (this.useFirebase) {
        try { await this._col('contacts').doc(id).update(data); } catch (e) { console.warn('Firebase contact update failed:', e); }
      }
      if (this.isElectron) await this.saveContacts();
      return this.contacts[index];
    }
    return null;
  }

  async deleteContact(id) {
    this.contacts = this.contacts.filter(c => c.id !== id);
    if (this.useFirebase) {
      try { await this._col('contacts').doc(id).delete(); } catch (e) { console.warn('Firebase contact delete failed:', e); }
    }
    if (this.isElectron) await this.saveContacts();
  }

  getContact(id) { return this.contacts.find(c => c.id === id) || null; }

  // --- Dokumente (Documents metadata) ---
  async loadDocuments() {
    if (this.useFirebase) {
      try {
        const snapshot = await this._col('documents').get();
        if (!snapshot.empty) {
          this.documents = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          return this.documents;
        }
      } catch (e) { console.warn('Firebase documents load failed:', e); }
    }
    if (this.isElectron) {
      this.documents = await window.api.getDocuments();
    }
    return this.documents;
  }

  async saveDocuments() {
    if (this.isElectron) await window.api.saveDocuments(this.documents);
  }

  async addDocument(docMeta) {
    docMeta.id = this.generateId();
    docMeta.createdAt = new Date().toISOString();
    this.documents.push(docMeta);
    if (this.useFirebase) {
      try { await this._col('documents').doc(docMeta.id).set(docMeta); } catch (e) { console.warn('Firebase doc add failed:', e); }
    }
    if (this.isElectron) await this.saveDocuments();
    return docMeta;
  }

  async deleteDocument(id) {
    this.documents = this.documents.filter(d => d.id !== id);
    if (this.useFirebase) {
      try { await this._col('documents').doc(id).delete(); } catch (e) { console.warn('Firebase doc delete failed:', e); }
    }
    if (this.isElectron) await this.saveDocuments();
  }

  // --- Kalender (Events) ---
  async loadEvents() {
    if (this.useFirebase) {
      try {
        const snapshot = await this._col('events').get();
        if (!snapshot.empty) {
          this.events = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          return this.events;
        }
      } catch (e) { console.warn('Firebase events load failed:', e); }
    }
    if (this.isElectron) {
      this.events = await window.api.getEvents();
    }
    return this.events;
  }

  async saveEvents() {
    if (this.isElectron) await window.api.saveEvents(this.events);
  }

  async addEvent(event) {
    event.id = this.generateId();
    event.createdAt = new Date().toISOString();
    this.events.push(event);
    if (this.useFirebase) {
      try { await this._col('events').doc(event.id).set(event); } catch (e) { console.warn('Firebase event add failed:', e); }
    }
    if (this.isElectron) await this.saveEvents();
    return event;
  }

  async updateEvent(id, data) {
    const index = this.events.findIndex(e => e.id === id);
    if (index !== -1) {
      this.events[index] = { ...this.events[index], ...data };
      if (this.useFirebase) {
        try { await this._col('events').doc(id).update(data); } catch (e) { console.warn('Firebase event update failed:', e); }
      }
      if (this.isElectron) await this.saveEvents();
      return this.events[index];
    }
    return null;
  }

  async deleteEvent(id) {
    this.events = this.events.filter(e => e.id !== id);
    if (this.useFirebase) {
      try { await this._col('events').doc(id).delete(); } catch (e) { console.warn('Firebase event delete failed:', e); }
    }
    if (this.isElectron) await this.saveEvents();
  }

  getEvent(id) { return this.events.find(e => e.id === id) || null; }

  getNextDonationNumber(prefix = 'SQ') {
    const year = new Date().getFullYear();
    const yearDonations = this.donations.filter(d => {
      const num = d.number || '';
      return num.includes(`${year}`);
    });
    const nextNum = yearDonations.length + 1;
    return `${prefix}-${year}-${String(nextNum).padStart(3, '0')}`;
  }

  // --- Helpers ---
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  calculateInvoiceTotal(invoice) {
    const settings = this.settings;
    let netto = 0;
    let mwst = 0;

    for (const item of (invoice.items || [])) {
      const itemNetto = item.quantity * item.price;
      netto += itemNetto;

      if (settings && settings.taxMode === 'regelbesteuerung') {
        const rate = item.taxRate != null ? item.taxRate : 19;
        mwst += itemNetto * (rate / 100);
      }
    }

    return {
      netto: Math.round(netto * 100) / 100,
      mwst: Math.round(mwst * 100) / 100,
      brutto: Math.round((netto + mwst) * 100) / 100,
    };
  }
}

const store = new Store();
