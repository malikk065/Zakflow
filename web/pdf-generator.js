// PDF Generator mit pdf-lib
// pdf-lib wird als UMD-Script im HTML vor diesem Skript geladen

async function generateInvoicePDF({ invoice, settings, customer, totals, logoData }) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;

  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();

  // Fonts
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Colors
  const black = rgb(0.1, 0.1, 0.12);
  const gray = rgb(0.4, 0.4, 0.45);
  const lightGray = rgb(0.85, 0.85, 0.88);
  const accent = rgb(0, 0.44, 0.89);
  const white = rgb(1, 1, 1);

  const marginLeft = 50;
  const marginRight = 50;
  const contentWidth = width - marginLeft - marginRight;

  let y = height - 50;

  // =====================
  // HEADER - Logo + Firmendaten
  // =====================
  const headerTop = y;
  let logoWidth = 0;

  // Logo (links)
  if (logoData && logoData.data) {
    try {
      let logoImage;
      if (logoData.mimeType.includes('png')) {
        logoImage = await doc.embedPng(Uint8Array.from(atob(logoData.data), c => c.charCodeAt(0)));
      } else if (logoData.mimeType.includes('jpeg') || logoData.mimeType.includes('jpg')) {
        logoImage = await doc.embedJpg(Uint8Array.from(atob(logoData.data), c => c.charCodeAt(0)));
      }

      if (logoImage) {
        const logoDims = logoImage.scale(1);
        const maxH = 60;
        const maxW = 150;
        const scale = Math.min(maxW / logoDims.width, maxH / logoDims.height, 1);
        const w = logoDims.width * scale;
        const h = logoDims.height * scale;
        page.drawImage(logoImage, {
          x: marginLeft,
          y: headerTop - h,
          width: w,
          height: h,
        });
        logoWidth = w + 20;
      }
    } catch (e) {
      console.error('Logo-Embed-Fehler:', e);
    }
  }

  // Firmendaten (rechts)
  const companyX = width - marginRight;
  const companyLines = [
    { text: settings.company.name || '', font: fontBold, size: 12 },
    { text: settings.company.address || '', font: fontRegular, size: 9 },
    { text: `${settings.company.zip || ''} ${settings.company.city || ''}`.trim(), font: fontRegular, size: 9 },
    { text: settings.company.phone ? `Tel: ${settings.company.phone}` : '', font: fontRegular, size: 9 },
    { text: settings.company.email || '', font: fontRegular, size: 9 },
    { text: settings.company.website || '', font: fontRegular, size: 9 },
  ].filter(l => l.text);

  let companyY = headerTop;
  for (const line of companyLines) {
    const tw = line.font.widthOfTextAtSize(line.text, line.size);
    page.drawText(line.text, {
      x: companyX - tw,
      y: companyY - line.size,
      size: line.size,
      font: line.font,
      color: line === companyLines[0] ? black : gray,
    });
    companyY -= line.size + 4;
  }

  y = Math.min(companyY, headerTop - 70) - 20;

  // =====================
  // Absenderzeile (klein)
  // =====================
  const senderLine = [
    settings.company.name,
    settings.company.address,
    `${settings.company.zip} ${settings.company.city}`.trim()
  ].filter(Boolean).join(' · ');

  page.drawText(senderLine, {
    x: marginLeft,
    y: y,
    size: 7,
    font: fontRegular,
    color: gray,
  });

  // Underline
  y -= 3;
  page.drawLine({
    start: { x: marginLeft, y },
    end: { x: marginLeft + 250, y },
    thickness: 0.5,
    color: lightGray,
  });

  y -= 16;

  // =====================
  // Kundenadresse
  // =====================
  if (customer) {
    const addrLines = [
      customer.name,
      customer.street,
      `${customer.zip || ''} ${customer.city || ''}`.trim(),
    ].filter(Boolean);

    for (const line of addrLines) {
      page.drawText(line, {
        x: marginLeft,
        y,
        size: 11,
        font: line === addrLines[0] ? fontBold : fontRegular,
        color: black,
      });
      y -= 16;
    }
  }

  y -= 20;

  // =====================
  // Rechnungsdetails (rechts)
  // =====================
  const detailsX = width - marginRight - 180;
  let detailY = y + 50;

  const details = [
    ['Rechnungsnummer:', invoice.number],
    ['Rechnungsdatum:', formatDateForPDF(invoice.date)],
    ['Zahlungsziel:', formatDateForPDF(addDays(invoice.date, invoice.dueDays || 14))],
  ];

  if (settings.company.taxNumber) {
    details.push(['Steuernummer:', settings.company.taxNumber]);
  }
  if (settings.company.vatId) {
    details.push(['USt-IdNr.:', settings.company.vatId]);
  }

  for (const [label, value] of details) {
    page.drawText(label, {
      x: detailsX,
      y: detailY,
      size: 8,
      font: fontRegular,
      color: gray,
    });
    page.drawText(value || '', {
      x: detailsX + 95,
      y: detailY,
      size: 8,
      font: fontBold,
      color: black,
    });
    detailY -= 14;
  }

  // =====================
  // RECHNUNG / GUTSCHRIFT Titel
  // =====================
  const isGutschrift = invoice.type === 'gutschrift';
  const docTitle = isGutschrift ? 'GUTSCHRIFT' : 'RECHNUNG';
  page.drawText(docTitle, {
    x: marginLeft,
    y: y,
    size: 22,
    font: fontBold,
    color: isGutschrift ? rgb(0.69, 0.32, 0.87) : black,
  });

  // Referenz bei Gutschrift
  if (isGutschrift && invoice.relatedInvoice) {
    y -= 18;
    page.drawText(`Zu Rechnung: ${invoice.relatedInvoice}`, {
      x: marginLeft,
      y,
      size: 9,
      font: fontRegular,
      color: gray,
    });
  }

  y -= 40;

  // =====================
  // Positionen-Tabelle
  // =====================
  const isKlein = invoice.taxMode === 'kleinunternehmer' || settings.taxMode === 'kleinunternehmer';

  // Spalten-Definition
  const cols = isKlein
    ? [
        { label: 'Pos.', width: 35, align: 'left' },
        { label: 'Beschreibung', width: 230, align: 'left' },
        { label: 'Menge', width: 50, align: 'right' },
        { label: 'Einheit', width: 45, align: 'left' },
        { label: 'Einzelpreis', width: 75, align: 'right' },
        { label: 'Gesamt', width: 75, align: 'right' },
      ]
    : [
        { label: 'Pos.', width: 30, align: 'left' },
        { label: 'Beschreibung', width: 190, align: 'left' },
        { label: 'Menge', width: 45, align: 'right' },
        { label: 'Einheit', width: 40, align: 'left' },
        { label: 'Einzelpreis', width: 70, align: 'right' },
        { label: 'MwSt', width: 40, align: 'right' },
        { label: 'Gesamt', width: 75, align: 'right' },
      ];

  // Tabellen-Header
  const tableHeaderH = 22;
  page.drawRectangle({
    x: marginLeft,
    y: y - tableHeaderH + 6,
    width: contentWidth,
    height: tableHeaderH,
    color: rgb(0.95, 0.95, 0.96),
  });

  let colX = marginLeft + 4;
  for (const col of cols) {
    const textX = col.align === 'right'
      ? colX + col.width - fontBold.widthOfTextAtSize(col.label, 8) - 4
      : colX;
    page.drawText(col.label, {
      x: textX,
      y: y - 10,
      size: 8,
      font: fontBold,
      color: gray,
    });
    colX += col.width;
  }

  y -= tableHeaderH + 4;

  // Tabellen-Zeilen
  const items = invoice.items || [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemTotal = item.quantity * item.price;

    // Alternating row background
    if (i % 2 === 1) {
      page.drawRectangle({
        x: marginLeft,
        y: y - 12,
        width: contentWidth,
        height: 20,
        color: rgb(0.98, 0.98, 0.99),
      });
    }

    colX = marginLeft + 4;
    const rowData = isKlein
      ? [
          String(i + 1),
          item.description || '',
          formatNumber(item.quantity),
          item.unit || 'Stk.',
          formatCurrencyPDF(item.price),
          formatCurrencyPDF(itemTotal),
        ]
      : [
          String(i + 1),
          item.description || '',
          formatNumber(item.quantity),
          item.unit || 'Stk.',
          formatCurrencyPDF(item.price),
          `${item.taxRate != null ? item.taxRate : 19}%`,
          formatCurrencyPDF(itemTotal),
        ];

    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      let text = rowData[c] || '';

      // Truncate description if too long
      if (c === 1) {
        const maxW = col.width - 8;
        while (fontRegular.widthOfTextAtSize(text, 9) > maxW && text.length > 3) {
          text = text.slice(0, -4) + '...';
        }
      }

      const tw = fontRegular.widthOfTextAtSize(text, 9);
      const textX = col.align === 'right' ? colX + col.width - tw - 4 : colX;

      page.drawText(text, {
        x: textX,
        y: y - 4,
        size: 9,
        font: fontRegular,
        color: black,
      });
      colX += col.width;
    }

    y -= 20;

    // Page break check
    if (y < 180) {
      // Add new page
      const newPage = doc.addPage([595.28, 841.89]);
      // TODO: For simplicity, we continue on same page
      // In production, handle page breaks properly
    }
  }

  // Tabellen-Linie unten
  y -= 4;
  page.drawLine({
    start: { x: marginLeft, y },
    end: { x: width - marginRight, y },
    thickness: 0.5,
    color: lightGray,
  });

  y -= 24;

  // =====================
  // Summen
  // =====================
  const sumX = width - marginRight - 180;
  const valX = width - marginRight;

  // Netto
  drawSumLine(page, 'Nettobetrag:', formatCurrencyPDF(totals.netto), sumX, valX, y, fontRegular, fontRegular, 10, gray, black);
  y -= 16;

  if (!isKlein) {
    // MwSt aufschlüsseln
    const taxGroups = {};
    for (const item of items) {
      const rate = item.taxRate != null ? item.taxRate : 19;
      if (!taxGroups[rate]) taxGroups[rate] = 0;
      taxGroups[rate] += item.quantity * item.price * (rate / 100);
    }

    for (const [rate, amount] of Object.entries(taxGroups)) {
      drawSumLine(page, `MwSt ${rate}%:`, formatCurrencyPDF(Math.round(amount * 100) / 100), sumX, valX, y, fontRegular, fontRegular, 10, gray, black);
      y -= 16;
    }
  }

  // Brutto-Linie ÜBER dem Text (y zuerst nach unten, dann Linie, dann Text)
  y -= 6;
  page.drawLine({
    start: { x: sumX, y },
    end: { x: valX, y },
    thickness: 1.5,
    color: black,
  });
  y -= 16;

  // Brutto
  const bruttoLabel = isKlein ? 'Gesamtbetrag:' : 'Bruttobetrag:';
  const bruttoPrefix = isGutschrift ? '-' : '';
  drawSumLine(page, bruttoLabel, bruttoPrefix + formatCurrencyPDF(totals.brutto), sumX, valX, y, fontBold, fontBold, 12, black, black);
  y -= 30;

  // =====================
  // Kleinunternehmer-Hinweis
  // =====================
  if (isKlein) {
    page.drawText('Gemäß §19 UStG wird keine Umsatzsteuer berechnet.', {
      x: marginLeft,
      y,
      size: 8,
      font: fontRegular,
      color: gray,
    });
    y -= 20;
  }

  // =====================
  // Bemerkungen
  // =====================
  if (invoice.notes) {
    y -= 10;
    page.drawText('Bemerkungen:', {
      x: marginLeft,
      y,
      size: 9,
      font: fontBold,
      color: black,
    });
    y -= 14;

    const noteLines = wrapText(invoice.notes, fontRegular, 9, contentWidth);
    for (const line of noteLines) {
      page.drawText(line, {
        x: marginLeft,
        y,
        size: 9,
        font: fontRegular,
        color: gray,
      });
      y -= 13;
    }
  }

  // =====================
  // Zahlungshinweis
  // =====================
  y -= 10;

  if (isGutschrift) {
    page.drawText(`Der Betrag von ${formatCurrencyPDF(totals.brutto)} wird gutgeschrieben.`, {
      x: marginLeft,
      y,
      size: 9,
      font: fontRegular,
      color: black,
    });
    y -= 20;
  } else if (invoice.paymentMethod === 'bar') {
    // Bar bezahlt - kein Überweisungshinweis
    page.drawText('Zahlungsart: Bar bezahlt', {
      x: marginLeft,
      y,
      size: 10,
      font: fontBold,
      color: black,
    });
    y -= 16;
    page.drawText(`Der Betrag von ${formatCurrencyPDF(totals.brutto)} wurde bar entgegengenommen.`, {
      x: marginLeft,
      y,
      size: 9,
      font: fontRegular,
      color: black,
    });
    y -= 14;
    page.drawText(`Datum: ${formatDateForPDF(invoice.date)}`, {
      x: marginLeft,
      y,
      size: 9,
      font: fontRegular,
      color: black,
    });
    y -= 20;
  } else {
    // Überweisung - Standard-Zahlungshinweis
    const paymentText = `Bitte überweisen Sie den Betrag von ${formatCurrencyPDF(totals.brutto)} bis zum ${formatDateForPDF(addDays(invoice.date, invoice.dueDays || 14))} auf folgendes Konto:`;
    page.drawText(paymentText, {
      x: marginLeft,
      y,
      size: 9,
      font: fontRegular,
      color: black,
    });
    y -= 20;

    // Bankdaten
    if (settings.company.bankName || settings.company.iban) {
      const bankInfo = [
        settings.company.bankName ? `Bank: ${settings.company.bankName}` : '',
        settings.company.iban ? `IBAN: ${settings.company.iban}` : '',
        settings.company.bic ? `BIC: ${settings.company.bic}` : '',
      ].filter(Boolean);

      for (const line of bankInfo) {
        page.drawText(line, {
          x: marginLeft,
          y,
          size: 9,
          font: fontRegular,
          color: black,
        });
        y -= 14;
      }
    }
  }

  // =====================
  // Fußzeile
  // =====================
  const footerY = 30;
  const footerParts = [
    settings.company.name,
    settings.company.taxNumber ? `St.Nr.: ${settings.company.taxNumber}` : '',
    settings.company.vatId ? `USt-IdNr.: ${settings.company.vatId}` : '',
  ].filter(Boolean);

  const footerText = footerParts.join('  ·  ');
  const footerWidth = fontRegular.widthOfTextAtSize(footerText, 7);

  page.drawLine({
    start: { x: marginLeft, y: footerY + 12 },
    end: { x: width - marginRight, y: footerY + 12 },
    thickness: 0.5,
    color: lightGray,
  });

  page.drawText(footerText, {
    x: (width - footerWidth) / 2,
    y: footerY,
    size: 7,
    font: fontRegular,
    color: gray,
  });

  return await doc.save();
}

// --- PDF Helpers ---
function drawSumLine(page, label, value, labelX, valueRight, y, labelFont, valueFont, size, labelColor, valueColor) {
  page.drawText(label, {
    x: labelX,
    y,
    size,
    font: labelFont,
    color: labelColor,
  });

  const vw = valueFont.widthOfTextAtSize(value, size);
  page.drawText(value, {
    x: valueRight - vw,
    y,
    size,
    font: valueFont,
    color: valueColor,
  });
}

function formatCurrencyPDF(amount) {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount) + ' €';
}

function formatNumber(num) {
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(2).replace('.', ',');
}

function formatDateForPDF(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);

    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}
