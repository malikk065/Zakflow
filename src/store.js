// Store - Datenverwaltung über Firebase (mit lokalem Fallback)

class Store {
  constructor() {
    this.settings = null;
    this.customers = [];
    this.invoices = [];
    this.expenses = [];
    this.useFirebase = false;
    this.isElectron = typeof window.api !== 'undefined';
    this._listeners = [];
    this.onDataChanged = null;
  }

  // --- Echtzeit-Listener starten ---
  startRealtimeSync() {
    if (!this.useFirebase) return;

    // Kunden-Listener
    const unsubCustomers = db.collection('customers').onSnapshot(snapshot => {
      this.customers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (this.onDataChanged) this.onDataChanged('customers');
    }, err => console.warn('Kunden-Listener Fehler:', err));
    this._listeners.push(unsubCustomers);

    // Rechnungen-Listener
    const unsubInvoices = db.collection('invoices').onSnapshot(snapshot => {
      this.invoices = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (this.onDataChanged) this.onDataChanged('invoices');
    }, err => console.warn('Rechnungen-Listener Fehler:', err));
    this._listeners.push(unsubInvoices);

    // Ausgaben-Listener
    const unsubExpenses = db.collection('expenses').onSnapshot(snapshot => {
      this.expenses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (this.onDataChanged) this.onDataChanged('expenses');
    }, err => console.warn('Ausgaben-Listener Fehler:', err));
    this._listeners.push(unsubExpenses);

    // Settings-Listener
    const unsubSettings = db.collection('app').doc('settings').onSnapshot(doc => {
      if (doc.exists) {
        this.settings = doc.data();
        if (this.onDataChanged) this.onDataChanged('settings');
      }
    }, err => console.warn('Settings-Listener Fehler:', err));
    this._listeners.push(unsubSettings);

    console.log('Echtzeit-Sync gestartet');
  }

  stopRealtimeSync() {
    this._listeners.forEach(unsub => unsub());
    this._listeners = [];
  }

  // --- Settings ---
  async loadSettings() {
    if (this.useFirebase) {
      try {
        const doc = await db.collection('app').doc('settings').get();
        if (doc.exists) {
          this.settings = doc.data();
          return this.settings;
        }
      } catch (e) { console.warn('Firebase settings load failed:', e); }
    }

    // Fallback: lokale Dateien (Electron)
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
        await db.collection('app').doc('settings').set(settings);
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
        const snapshot = await db.collection('customers').get();
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
    // Firebase: Kunden werden einzeln gespeichert (add/update/delete)
  }

  async addCustomer(customer) {
    customer.id = this.generateId();
    customer.createdAt = new Date().toISOString();
    this.customers.push(customer);

    if (this.useFirebase) {
      try {
        await db.collection('customers').doc(customer.id).set(customer);
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
          await db.collection('customers').doc(id).update(data);
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
        await db.collection('customers').doc(id).delete();
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
        const snapshot = await db.collection('invoices').get();
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
    // Firebase: Rechnungen werden einzeln gespeichert
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
        await db.collection('invoices').doc(invoice.id).set(invoice);
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
          await db.collection('invoices').doc(id).update(data);
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
        await db.collection('invoices').doc(id).delete();
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
        const snapshot = await db.collection('expenses').get();
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
        await db.collection('expenses').doc(expense.id).set(expense);
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
          await db.collection('expenses').doc(id).update(data);
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
        await db.collection('expenses').doc(id).delete();
      } catch (e) { console.warn('Firebase expense delete failed:', e); }
    }

    if (this.isElectron) await this.saveExpenses();
  }

  getExpense(id) {
    return this.expenses.find(e => e.id === id) || null;
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
