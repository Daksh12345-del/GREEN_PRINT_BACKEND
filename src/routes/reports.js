const express = require("express");
const PDFDocument = require("pdfkit");
const { query } = require("../lib/db");
const { requireAuth, resolveCompanyId } = require("../lib/auth");
const { computeKPIs, readSnapshot } = require("../lib/emissions");

const router = express.Router();
router.use(requireAuth);

const FUEL_TYPES = ["diesel", "petrol", "natural_gas", "lpg", "coal"];

// Brand palette — matches the app's own design tokens (client/src/index.css)
const COLOR = {
  brand: "#1F5F45",
  brandStrong: "#163F2F",
  brandSoft: "#E4EEE7",
  good: "#2E7D4F",
  warn: "#B5762C",
  warnSoft: "#FBF0E1",
  crit: "#A6382F",
  critSoft: "#FBE7E4",
  ink: "#17211C",
  inkSoft: "#55625B",
  inkFaint: "#8B968F",
  border: "#DDE3DA",
  bg: "#F4F6F2",
  purple: "#7A3FB0"
};

const PAGE_W = 595.28; // A4 at 72dpi
const PAGE_H = 841.89;
const MARGIN = 50;

// A simple vector leaf mark — no external image asset needed, so this
// renders identically everywhere this PDF is opened.
function drawLogoMark(doc, x, y, size, { bg = COLOR.brand, leaf = "#ffffff" } = {}) {
  doc.save();
  doc.circle(x + size / 2, y + size / 2, size / 2).fill(bg);
  const cx = x + size / 2;
  const cy = y + size / 2;
  const s = size * 0.32;
  doc
    .path(
      `M ${cx - s} ${cy + s} C ${cx - s} ${cy - s * 0.3}, ${cx - s * 0.3} ${cy - s}, ${cx + s} ${cy - s} ` +
      `C ${cx + s} ${cy + s * 0.3}, ${cx + s * 0.3} ${cy + s}, ${cx - s} ${cy + s} Z`
    )
    .fill(leaf);
  doc.restore();
}

function drawFooter(doc, pageNum, totalPages, companyName) {
  const y = PAGE_H - 46;
  // Drawing this far down is technically inside the page's bottom margin,
  // which would otherwise make PDFKit think the content overflows and
  // silently insert a brand-new page mid-footer. Temporarily disable that
  // check for the footer only, then restore it.
  const originalBottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  doc.save();
  doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).lineWidth(0.75).strokeColor(COLOR.border).stroke();
  drawLogoMark(doc, MARGIN, y + 8, 14);
  doc
    .fontSize(8)
    .fillColor(COLOR.inkSoft)
    .font("Helvetica-Bold")
    .text("Green Print", MARGIN + 20, y + 11, { continued: true, lineBreak: false })
    .font("Helvetica")
    .fillColor(COLOR.inkFaint)
    .text(`  ·  Carbon Intelligence Platform  ·  issued for ${companyName}`, { lineBreak: false });
  doc
    .fontSize(8)
    .fillColor(COLOR.inkFaint)
    .text(`Page ${pageNum} of ${totalPages}`, MARGIN, y + 11, { width: PAGE_W - MARGIN * 2, align: "right", lineBreak: false });
  doc.restore();

  doc.page.margins.bottom = originalBottomMargin;
}

function sectionHeading(doc, text) {
  doc.moveDown(0.3);
  doc.fontSize(14).font("Helvetica-Bold").fillColor(COLOR.ink).text(text);
  doc.moveTo(MARGIN, doc.y + 4).lineTo(MARGIN + 36, doc.y + 4).lineWidth(2.5).strokeColor(COLOR.brand).stroke();
  doc.moveDown(0.8);
}

// A bordered stat card with a colored left accent bar — used on the
// summary page instead of a plain bullet list.
function drawStatCard(doc, x, y, w, h, { label, value, unit, accent = COLOR.brand }) {
  doc.save();
  doc.roundedRect(x, y, w, h, 6).fillAndStroke("#ffffff", COLOR.border);
  doc.rect(x, y, 4, h).fill(accent);
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(COLOR.inkSoft)
    .text(label.toUpperCase(), x + 14, y + 12, { width: w - 24, characterSpacing: 0.3 });
  doc.fontSize(19).font("Helvetica-Bold").fillColor(COLOR.ink)
    .text(value, x + 14, y + 28, { width: w - 24, continued: unit ? true : false });
  if (unit) {
    doc.fontSize(10).font("Helvetica").fillColor(COLOR.inkFaint).text(`  ${unit}`);
  }
  doc.restore();
}

// Horizontal bar comparison (Scope 1 vs Scope 2), drawn with plain
// rectangles so it doesn't depend on any charting library.
function drawScopeBars(doc, x, y, w, scope1, scope2) {
  const max = Math.max(scope1, scope2, 1);
  const barH = 22;
  const labelW = 90;
  const trackW = w - labelW - 60;

  const rows = [
    { label: "Scope 1 (fuel)", value: scope1, color: COLOR.purple },
    { label: "Scope 2 (electricity)", value: scope2, color: COLOR.brand }
  ];

  rows.forEach((row, i) => {
    const rowY = y + i * (barH + 10);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.inkSoft).text(row.label, x, rowY + 6, { width: labelW });
    doc.roundedRect(x + labelW, rowY, trackW, barH, 4).fill(COLOR.bg);
    const fillW = Math.max(4, (row.value / max) * trackW);
    doc.roundedRect(x + labelW, rowY, fillW, barH, 4).fill(row.color);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.ink)
      .text(`${row.value.toFixed(1)} kg`, x + labelW + trackW + 8, rowY + 6, { width: 60 });
  });

  return y + rows.length * (barH + 10);
}

router.get("/esg.pdf", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }

    const company = (await query("SELECT * FROM companies WHERE id = $1", [companyId])).rows[0];
    if (!company) return res.status(404).json({ error: "Company not found" });

    const logs = (
      await query("SELECT * FROM logs WHERE company_id = $1 ORDER BY timestamp ASC", [companyId])
    ).rows;
    const kpis = computeKPIs(logs);

    const sourcesUsed = new Map();
    let scope1Co2e = 0, scope2Co2e = 0, totalNox = 0, totalSox = 0;

    for (const log of logs) {
      const e = readSnapshot(log);
      if (FUEL_TYPES.includes(log.activity_type)) scope1Co2e += e.CO2e || 0;
      if (log.activity_type === "electricity") scope2Co2e += e.CO2e || 0;
      totalNox += e.NOx || 0;
      totalSox += e.SOx || 0;
      for (const f of e.factorsUsed) {
        sourcesUsed.set(`${f.region}-${log.activity_type}-${f.pollutant}`, f);
      }
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="greenprint-esg-report-${company.name.replace(/\s+/g, "-")}.pdf"`
    );

    const doc = new PDFDocument({ margin: MARGIN, size: "A4", bufferPages: true });
    doc.pipe(res);

    // ===================== COVER PAGE =====================
    doc.rect(0, 0, PAGE_W, 190).fill(COLOR.brandStrong);
    drawLogoMark(doc, MARGIN, 44, 40);
    doc.fontSize(20).font("Helvetica-Bold").fillColor("#ffffff").text("Green Print", MARGIN + 52, 54);
    doc.fontSize(10).font("Helvetica").fillColor(COLOR.brandSoft).text("Carbon Intelligence Platform", MARGIN + 52, 78);

    doc.fontSize(11).font("Helvetica").fillColor(COLOR.brandSoft)
      .text("CARBON & ESG EMISSIONS REPORT", MARGIN, 130, { characterSpacing: 1.2 });

    doc.moveDown(3);
    doc.fontSize(26).font("Helvetica-Bold").fillColor(COLOR.ink).text(company.name, MARGIN, 220);
    doc.fontSize(12).font("Helvetica").fillColor(COLOR.inkSoft)
      .text(`${company.sector}  ·  ${company.scale}  ·  Region: ${company.region}`, MARGIN, 254);

    doc.fontSize(10).fillColor(COLOR.inkFaint)
      .text(`Generated ${new Date().toLocaleString()}  ·  Covers ${kpis.sampleSize} logged data point${kpis.sampleSize === 1 ? "" : "s"}`, MARGIN, 276);

    // Headline number, front and center
    doc.fontSize(13).font("Helvetica-Bold").fillColor(COLOR.inkSoft).text("TOTAL EMISSIONS", MARGIN, 340);
    doc.fontSize(44).font("Helvetica-Bold").fillColor(COLOR.brand)
      .text(`${(kpis.co2e / 1000).toFixed(2)}`, MARGIN, 362, { continued: true });
    doc.fontSize(18).font("Helvetica").fillColor(COLOR.inkSoft).text("  tonnes CO2e");
    doc.fontSize(10).fillColor(COLOR.inkFaint).text(`(${kpis.co2e.toLocaleString()} kg)`, MARGIN, 412);

    // Disclaimer box — always visible, never buried
    const discY = 470;
    doc.roundedRect(MARGIN, discY, PAGE_W - MARGIN * 2, 100, 8).fillAndStroke(COLOR.warnSoft, "#e8d3ae");
    doc.fontSize(9.5).font("Helvetica-Bold").fillColor("#5c4116").text("Please read before sharing this report", MARGIN + 16, discY + 14, { width: PAGE_W - MARGIN * 2 - 32 });
    doc.fontSize(9).font("Helvetica").fillColor("#5c4116").text(
      "This report is issued by Green Print and formatted to align with the GHG Protocol's Scope 1/2 " +
      "structure. It is NOT a certified or third-party-audited statement — ISO 14001, GHG Protocol, BRSR, " +
      "and CDP certification require independent verification by an accredited auditor, which this " +
      "software does not perform.",
      MARGIN + 16, discY + 32, { width: PAGE_W - MARGIN * 2 - 32, lineGap: 2 }
    );

    // ===================== SUMMARY PAGE =====================
    doc.addPage();
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.inkFaint).text("SUMMARY", MARGIN, MARGIN, { characterSpacing: 1 });
    doc.moveDown(1);
    sectionHeading(doc, "Emissions at a glance");

    const cardY = doc.y;
    const cardW = (PAGE_W - MARGIN * 2 - 24) / 3;
    const cardH = 68;
    drawStatCard(doc, MARGIN, cardY, cardW, cardH, { label: "Total CO2e", value: kpis.co2e.toLocaleString(), unit: "kg", accent: COLOR.brand });
    drawStatCard(doc, MARGIN + cardW + 12, cardY, cardW, cardH, { label: "Renewable share", value: `${kpis.renewableShare}`, unit: "%", accent: COLOR.good });
    drawStatCard(doc, MARGIN + (cardW + 12) * 2, cardY, cardW, cardH, { label: "Green Score", value: `${kpis.esgScore}`, unit: "/ 100", accent: kpis.esgScore >= 70 ? COLOR.good : COLOR.warn });

    const card2Y = cardY + cardH + 12;
    drawStatCard(doc, MARGIN, card2Y, cardW, cardH, { label: "NOx", value: `${kpis.nox}`, unit: "kg", accent: COLOR.warn });
    drawStatCard(doc, MARGIN + cardW + 12, card2Y, cardW, cardH, { label: "SOx", value: `${kpis.sox}`, unit: "kg", accent: COLOR.crit });
    drawStatCard(doc, MARGIN + (cardW + 12) * 2, card2Y, cardW, cardH, { label: "Data points", value: `${kpis.sampleSize}`, unit: "logs", accent: COLOR.purple });

    doc.y = card2Y + cardH + 30;
    sectionHeading(doc, "Scope 1 vs. Scope 2");
    const afterBarsY = drawScopeBars(doc, MARGIN, doc.y, PAGE_W - MARGIN * 2, scope1Co2e, scope2Co2e);
    doc.y = afterBarsY + 20;

    sectionHeading(doc, "Green Score note (illustrative, not a certified rating)");
    doc.fontSize(9.5).font("Helvetica").fillColor(COLOR.inkSoft).text(
      `${kpis.esgScore}/100 — ` +
      (kpis.esgScore >= 70
        ? "a strong sustainability position given current renewable share and total emissions."
        : "there's room to improve — see the AI Insights page in the app for specific recommendations."),
      { width: PAGE_W - MARGIN * 2, lineGap: 3 }
    );

    // ===================== ACTIVITY LOG PAGE(S) =====================
    doc.addPage();
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.inkFaint).text("ACTIVITY LOG", MARGIN, MARGIN, { characterSpacing: 1 });
    doc.moveDown(1);
    sectionHeading(doc, "Scope 1 & 2 detail");

    const colX = { date: MARGIN, activity: MARGIN + 85, qty: MARGIN + 200, co2e: MARGIN + 300, scope: MARGIN + 390 };
    const tableW = PAGE_W - MARGIN * 2;
    const rowH = 20;

    function drawTableHeader() {
      const y = doc.y;
      doc.rect(MARGIN, y, tableW, rowH).fill(COLOR.brandStrong);
      doc.fontSize(8.5).font("Helvetica-Bold").fillColor("#ffffff");
      doc.text("DATE", colX.date + 6, y + 6);
      doc.text("ACTIVITY", colX.activity + 6, y + 6);
      doc.text("QUANTITY", colX.qty + 6, y + 6);
      doc.text("CO2E (KG)", colX.co2e + 6, y + 6);
      doc.text("SCOPE", colX.scope + 6, y + 6);
      doc.y = y + rowH;
    }

    drawTableHeader();
    const rowsToShow = logs.slice(-60);
    rowsToShow.forEach((log, i) => {
      if (doc.y + rowH > PAGE_H - 70) {
        doc.addPage();
        doc.y = MARGIN;
        drawTableHeader();
      }
      const y = doc.y;
      const e = readSnapshot(log);
      const scope = FUEL_TYPES.includes(log.activity_type) ? "Scope 1" : "Scope 2";
      if (i % 2 === 0) doc.rect(MARGIN, y, tableW, rowH).fill(COLOR.bg);
      doc.fontSize(8.5).font("Helvetica").fillColor(COLOR.ink);
      doc.text(new Date(log.timestamp).toLocaleDateString(), colX.date + 6, y + 6);
      doc.text(log.activity_type, colX.activity + 6, y + 6);
      doc.text(`${log.quantity} ${log.unit}`, colX.qty + 6, y + 6);
      doc.text(`${(e.CO2e || 0).toFixed(1)}`, colX.co2e + 6, y + 6);
      doc.fillColor(scope === "Scope 1" ? COLOR.purple : COLOR.brand)
        .font("Helvetica-Bold").text(scope, colX.scope + 6, y + 6);
      doc.y = y + rowH;
    });
    if (logs.length > 60) {
      doc.moveDown(0.6);
      doc.fontSize(8).fillColor(COLOR.inkFaint).text(`(showing most recent 60 of ${logs.length} entries)`);
    }

    // ===================== METHODOLOGY PAGE =====================
    doc.addPage();
    doc.fontSize(9).font("Helvetica-Bold").fillColor(COLOR.inkFaint).text("METHODOLOGY", MARGIN, MARGIN, { characterSpacing: 1 });
    doc.moveDown(1);
    sectionHeading(doc, "Emission factor sources");
    doc.fontSize(9.5).font("Helvetica").fillColor(COLOR.inkSoft).text(
      "Every figure in this report is Activity Quantity × Emission Factor. Each entry below shows the " +
      "factor that was in effect on the day it was logged — if an entry was recorded last year, it keeps " +
      "last year's factor even if that number has since been updated, so historical figures never silently " +
      `change. The factors used for ${company.name}'s entries were:`,
      { width: PAGE_W - MARGIN * 2, lineGap: 2 }
    );
    doc.moveDown(0.8);

    for (const f of sourcesUsed.values()) {
      const boxY = doc.y;
      const boxH = 44;
      doc.roundedRect(MARGIN, boxY, PAGE_W - MARGIN * 2, boxH, 5).fillAndStroke("#ffffff", COLOR.border);
      doc.rect(MARGIN, boxY, 3, boxH).fill(COLOR.brand);
      doc.fontSize(9.5).font("Helvetica-Bold").fillColor(COLOR.ink)
        .text(`${f.pollutant} — ${f.factorValue} kg per ${f.unit}  (region: ${f.region})`, MARGIN + 14, boxY + 9, { width: PAGE_W - MARGIN * 2 - 28 });
      doc.fontSize(8.5).font("Helvetica").fillColor(COLOR.inkSoft)
        .text(`Source: ${f.source}`, MARGIN + 14, boxY + 25, { width: PAGE_W - MARGIN * 2 - 28 });
      doc.y = boxY + boxH + 8;
    }

    doc.moveDown(0.6);
    sectionHeading(doc, "Compliance framework alignment (self-declared, not certified)");
    doc.fontSize(9).font("Helvetica").fillColor(COLOR.inkSoft).text(
      "• GHG Protocol — Scope 1/2 categorization used throughout this report.\n" +
      "• ISO 14001 — this report can support an EMS data trail but does not itself constitute certification.\n" +
      "• BRSR / CDP — the Summary section maps to typical energy/emissions disclosure fields in these " +
      "frameworks, but does not replace the official disclosure forms those frameworks require.\n\n" +
      "Independent verification by an accredited third party is required before any of the above can be " +
      "claimed as certified.",
      { width: PAGE_W - MARGIN * 2, lineGap: 3 }
    );

    // ===================== FOOTER + PAGE NUMBERS ON EVERY PAGE =====================
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(doc, i - range.start + 1, range.count, company.name);
    }

    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong generating the report" });
    }
  }
});

// ---------------------------------------------------------------------------
// CSV export — every logged activity + its stored (historically accurate)
// emissions breakdown, for opening directly in Excel/Google Sheets/etc.
// Uses the same stored snapshot as everything else — never recomputes
// against current factors, so this export matches the PDF report exactly.
// ---------------------------------------------------------------------------

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsvRow(values) {
  return values.map(csvEscape).join(",") + "\r\n";
}

router.get("/logs.csv", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "companyId is required (super_admin: pass ?companyId=)" });
    }

    const company = (await query("SELECT * FROM companies WHERE id = $1", [companyId])).rows[0];
    if (!company) return res.status(404).json({ error: "Company not found" });

    const logs = (
      await query(
        `SELECT l.*, f.name AS facility_name, v.name AS vehicle_name
         FROM logs l
         LEFT JOIN facilities f ON f.id = l.facility_id
         LEFT JOIN vehicles v ON v.id = l.vehicle_id
         WHERE l.company_id = $1
         ORDER BY l.timestamp ASC`,
        [companyId]
      )
    ).rows;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="greenprint-logs-${company.name.replace(/\s+/g, "-")}.csv"`
    );

    res.write(
      toCsvRow([
        "Date", "Activity Type", "Quantity", "Unit", "Facility", "Vehicle",
        "Renewable Share (%)", "CO2e (kg)", "NOx (kg)", "SOx (kg)", "Source", "Logged By (user id)"
      ])
    );

    for (const log of logs) {
      const e = readSnapshot(log);
      res.write(
        toCsvRow([
          new Date(log.timestamp).toISOString(),
          log.activity_type,
          log.quantity,
          log.unit,
          log.facility_name || "",
          log.vehicle_name || "",
          log.renewable_share,
          e.CO2e ?? "",
          e.NOx ?? "",
          e.SOx ?? "",
          log.source,
          log.recorded_by ?? ""
        ])
      );
    }

    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong generating the CSV export" });
    }
  }
});

module.exports = router;
