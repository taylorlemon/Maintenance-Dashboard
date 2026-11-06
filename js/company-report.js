// The summary PDF at the front of a company's data download (Admin → Company →
// Download All Their Data, downloadCompanyData in js/admin.js). Built from the
// same records the zip holds: one overview page for the company, then a page
// per building — work orders (with a 12-month chart), busiest rooms,
// preventative maintenance, room turns, compliance and CapEx.
//
// Work order numbers come from StoneAnchor's own task lists. Cancelled tasks
// (entered by mistake) never count. Months and "today" are in each building's
// own time zone.

var CR_COLORS = {
  accent: [148, 73, 47],    // --accent (headings, table headers)
  ink: [41, 38, 26],        // --text
  muted: [104, 103, 86],    // --text-muted
  grid: [228, 217, 203],    // --border
  opened: [224, 151, 58],   // --series-1 mustard: work orders opened (same as the trend chart)
  completed: [63, 125, 60], // --success green: work orders completed
  danger: [207, 52, 38]
};

function crDay(ts, tz) {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: tz || "America/Denver" });
}

function crMoney(n) {
  return "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
}

function crPct(part, whole) {
  return whole ? Math.round(100 * part / whole) + "%" : "—";
}

// The last 12 full-or-current months, oldest first, as "YYYY-MM".
function crMonths(today) {
  var y = +today.slice(0, 4), m = +today.slice(5, 7), out = [];
  for (var i = 11; i >= 0; i--) {
    var mm = m - i, yy = y;
    while (mm < 1) { mm += 12; yy--; }
    out.push(yy + "-" + String(mm).padStart(2, "0"));
  }
  return out;
}

function crMonthLabel(ym, withYear) {
  var d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1);
  return d.toLocaleDateString("en-US", withYear ? { month: "short", year: "numeric" } : { month: "short" });
}

// Every number on one building's page.
function crBuildingStats(prop, data) {
  var tz = prop.time_zone || "America/Denver";
  var today = crDay(new Date().toISOString(), tz);
  var months = crMonths(today);
  var from = months[0];
  var listKind = {};
  data["task lists"].forEach(function(l) { if (l.property_code === prop.code) listKind[l.id] = l.kind; });
  var tasks = data["tasks"].filter(function(t) { return t.property_code === prop.code && !t.cancelled_at && listKind[t.list_id]; });
  function ofKind(k) { return tasks.filter(function(t) { return listKind[t.list_id] === k; }); }
  var wo = ofKind("work_orders"), pm = ofKind("pm"), rt = ofKind("room_turns"), comp = ofKind("compliance");
  var inYear = function(ts) { return ts && crDay(ts, tz).slice(0, 7) >= from; };

  var byMonth = {};
  months.forEach(function(m) { byMonth[m] = { opened: 0, completed: 0 }; });
  var daysTotal = 0, daysCount = 0;
  wo.forEach(function(t) {
    var cm = crDay(t.created_at, tz).slice(0, 7);
    if (byMonth[cm]) byMonth[cm].opened++;
    if (t.completed_at) {
      var dm = crDay(t.completed_at, tz).slice(0, 7);
      if (byMonth[dm]) {
        byMonth[dm].completed++;
        daysTotal += (new Date(t.completed_at) - new Date(t.created_at)) / 86400000;
        daysCount++;
      }
    }
  });
  var openWo = wo.filter(function(t) { return !t.completed_at; });

  // Busiest rooms: work orders opened in the last 12 months, by room ("General"
  // is the import's stand-in for "no room in the name", so it's left out).
  var rooms = {};
  wo.forEach(function(t) {
    if (!inYear(t.created_at) || t.room === "General") return;
    var k = t.room.toLowerCase();
    if (!rooms[k]) rooms[k] = { room: t.room, count: 0, last: "" };
    rooms[k].count++;
    if (t.created_at > rooms[k].last) rooms[k].last = t.created_at;
  });
  var busiest = Object.keys(rooms).map(function(k) { return rooms[k]; })
    .sort(function(a, b) { return b.count - a.count || (b.last > a.last ? 1 : -1); }).slice(0, 10);

  var pmDone = pm.filter(function(t) { return inYear(t.completed_at) && t.due_date; });
  var pmOnTime = pmDone.filter(function(t) { return crDay(t.completed_at, tz) <= t.due_date; }).length;

  var in30 = new Date(today + "T00:00:00"); in30.setDate(in30.getDate() + 30);
  var in30s = in30.toLocaleDateString("en-CA");
  var compOpen = comp.filter(function(t) { return !t.completed_at; });
  var compOverdue = compOpen.filter(function(t) { return t.due_date && t.due_date < today; })
    .sort(function(a, b) { return a.due_date < b.due_date ? -1 : 1; });

  var year = today.slice(0, 4);
  var budgetRow = data["yearly budgets"].find(function(b) { return b.property_code === prop.code && String(b.year) === year; });
  var archived = {};
  data["projects"].forEach(function(p) { if (p.archived_at) archived[p.id] = true; });
  var spent = data["expenses"].filter(function(e) {
    return e.property_code === prop.code && e.expense_date && e.expense_date.slice(0, 4) === year && !(e.project_id && archived[e.project_id]);
  }).reduce(function(s, e) { return s + Number(e.amount); }, 0);
  var projects = data["projects"].filter(function(p) { return p.property_code === prop.code && !p.archived_at; });

  return {
    name: prop.name, code: prop.code, today: today, months: months, byMonth: byMonth,
    openWo: openWo.length,
    overdueWo: openWo.filter(function(t) { return t.due_date && t.due_date < today; }).length,
    opened12: months.reduce(function(s, m) { return s + byMonth[m].opened; }, 0),
    completed12: months.reduce(function(s, m) { return s + byMonth[m].completed; }, 0),
    avgDays: daysCount ? (daysTotal / daysCount).toFixed(1) : "—",
    busiest: busiest,
    pmDone12: pmDone.length, pmOnTime: pmOnTime,
    pmOverdue: pm.filter(function(t) { return !t.completed_at && t.due_date && t.due_date < today; }).length,
    rtDone12: rt.filter(function(t) { return inYear(t.completed_at); }).length,
    rtOpen: rt.filter(function(t) { return !t.completed_at; }).length,
    compOpen: compOpen.length, compOverdue: compOverdue,
    compSoon: compOpen.filter(function(t) { return t.due_date && t.due_date >= today && t.due_date <= in30s; }).length,
    year: year, budget: budgetRow ? Number(budgetRow.budget) : null, spent: spent,
    projectsActive: projects.filter(function(p) { return p.status !== "completed"; }).length,
    projectsDone: projects.filter(function(p) { return p.status === "completed" && p.completed_at && p.completed_at.slice(0, 4) === year; }).length
  };
}

// Opened vs completed per month: grouped bars on one axis, recessive grid,
// a legend (two series), and the numbers in a table just below it.
function crDrawChart(doc, s, x, y, w, h) {
  var max = 1;
  s.months.forEach(function(m) { max = Math.max(max, s.byMonth[m].opened, s.byMonth[m].completed); });
  var step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : Math.ceil(max / 5 / 50) * 50;
  var top = Math.ceil(max / step) * step;
  var plotX = x + 28, plotW = w - 28, plotH = h - 18;
  doc.setFontSize(7);
  doc.setLineWidth(0.5);
  for (var v = 0; v <= top; v += step) {
    var gy = y + plotH - plotH * v / top;
    doc.setDrawColor.apply(doc, CR_COLORS.grid);
    doc.line(plotX, gy, plotX + plotW, gy);
    doc.setTextColor.apply(doc, CR_COLORS.muted);
    doc.text(String(v), plotX - 5, gy + 2.5, { align: "right" });
  }
  var slot = plotW / s.months.length, bw = Math.min(11, (slot - 8) / 2);
  s.months.forEach(function(m, i) {
    var cx = plotX + slot * i + slot / 2;
    [["opened", CR_COLORS.opened, -1], ["completed", CR_COLORS.completed, 1]].forEach(function(b) {
      var val = s.byMonth[m][b[0]];
      if (!val) return;
      var bh = plotH * val / top;
      doc.setFillColor.apply(doc, b[1]);
      // 1pt gap between the pair; rounded top, flat on the baseline.
      var bx = b[2] < 0 ? cx - bw - 1 : cx + 1;
      doc.roundedRect(bx, y + plotH - bh, bw, bh, Math.min(2, bh / 2), Math.min(2, bh / 2), "F");
      if (bh > 2) doc.rect(bx, y + plotH - Math.min(2, bh / 2), bw, Math.min(2, bh / 2), "F");
    });
    doc.setTextColor.apply(doc, CR_COLORS.muted);
    doc.text(crMonthLabel(m, i === 0 || m.slice(5) === "01"), cx, y + plotH + 10, { align: "center" });
  });
  doc.setTextColor.apply(doc, CR_COLORS.ink);
}

function crLegend(doc, x, y) {
  doc.setFontSize(8);
  [["Opened", CR_COLORS.opened], ["Completed", CR_COLORS.completed]].forEach(function(l, i) {
    var lx = x + i * 80;
    doc.setFillColor.apply(doc, l[1]);
    doc.roundedRect(lx, y - 6, 8, 8, 1.5, 1.5, "F");
    doc.setTextColor.apply(doc, CR_COLORS.ink);
    doc.text(l[0], lx + 12, y + 1);
  });
}

function crHeading(doc, text, y) {
  doc.setFontSize(11);
  doc.setFont(undefined, "bold");
  doc.setTextColor.apply(doc, CR_COLORS.accent);
  doc.text(text, 40, y);
  doc.setFont(undefined, "normal");
  doc.setTextColor.apply(doc, CR_COLORS.ink);
}

function crTable(doc, startY, head, body, opts) {
  doc.autoTable(Object.assign({
    startY: startY, head: [head], body: body, margin: { left: 40, right: 40 },
    styles: { fontSize: 8, cellPadding: 3.5, textColor: CR_COLORS.ink, lineColor: CR_COLORS.grid, lineWidth: 0.5 },
    headStyles: { fillColor: CR_COLORS.accent, textColor: [255, 255, 255] },
    theme: "grid"
  }, opts || {}));
  return doc.lastAutoTable.finalY;
}

// Returns the PDF as a Blob.
function buildCompanySummaryPdf(companyName, data) {
  var doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
  var buildings = data["buildings"].slice().sort(function(a, b) { return a.name.localeCompare(b.name); });
  var stats = buildings.map(function(p) { return crBuildingStats(p, data); });
  var printed = new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  var range = stats.length ? crMonthLabel(stats[0].months[0], true) + " – " + crMonthLabel(stats[0].months[11], true) : "";

  // ── Overview ──
  doc.setFontSize(20);
  doc.setTextColor.apply(doc, CR_COLORS.accent);
  doc.text(companyName, 40, 54);
  doc.setFontSize(10);
  doc.setTextColor.apply(doc, CR_COLORS.muted);
  doc.text("StoneAnchor summary · downloaded " + printed + " · work orders over the last 12 months (" + range + ")", 40, 72);
  doc.setTextColor.apply(doc, CR_COLORS.ink);

  var sum = function(k) { return stats.reduce(function(s, x) { return s + (Number(x[k]) || 0); }, 0); };
  var y = crTable(doc, 88,
    ["Building", "Open work orders", "Overdue", "Opened (12 mo)", "Completed (12 mo)", "Avg days to complete", "PM on time", "Compliance overdue", "CapEx spent / budget"],
    stats.map(function(s) {
      return [s.name, s.openWo, s.overdueWo, s.opened12, s.completed12, s.avgDays, crPct(s.pmOnTime, s.pmDone12), s.compOverdue.length,
        crMoney(s.spent) + " / " + (s.budget === null ? "no budget" : crMoney(s.budget))];
    }).concat(stats.length > 1 ? [["All buildings", sum("openWo"), sum("overdueWo"), sum("opened12"), sum("completed12"), "", "",
      stats.reduce(function(n, s) { return n + s.compOverdue.length; }, 0), crMoney(sum("spent"))]] : []),
    { styles: { fontSize: 8, cellPadding: 3.5, halign: "center", textColor: CR_COLORS.ink, lineColor: CR_COLORS.grid, lineWidth: 0.5 },
      columnStyles: { 0: { halign: "left", fontStyle: "bold" }, 8: { halign: "right" } } });

  var today = new Date().toLocaleDateString("en-CA");
  var in90 = new Date(); in90.setDate(in90.getDate() + 90);
  var expiring = data["vendor contracts"].filter(function(c) { return c.expires_on && c.expires_on >= today && c.expires_on <= in90.toLocaleDateString("en-CA"); }).length;
  var counts = [
    ["People with access", data["people"].length],
    ["Vendors", data["vendors"].length],
    ["Vendor contracts expiring in the next 90 days", expiring],
    ["Projects (not archived)", data["projects"].filter(function(p) { return !p.archived_at; }).length],
    ["Work orders, PM, room turns and compliance items on record (all time)", data["tasks"].length],
    ["Notes on record", data["task notes"].length]
  ];
  crHeading(doc, "At a glance", y + 28);
  crTable(doc, y + 36, ["", ""], counts, { showHead: "never", columnStyles: { 1: { halign: "right", cellWidth: 80 } }, tableWidth: 360 });

  // ── One page per building ──
  stats.forEach(function(s) {
    doc.addPage();
    doc.setFontSize(18);
    doc.setTextColor.apply(doc, CR_COLORS.accent);
    doc.text(s.name, 40, 52);
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, CR_COLORS.muted);
    doc.text(s.code + " · as of " + s.today, 40, 66);

    // Headline numbers.
    var tiles = [["Open work orders", s.openWo], ["Overdue", s.overdueWo], ["Opened (12 mo)", s.opened12],
                 ["Completed (12 mo)", s.completed12], ["Avg days to complete", s.avgDays]];
    tiles.forEach(function(t, i) {
      var tx = 40 + i * 106;
      doc.setFontSize(18);
      doc.setTextColor.apply(doc, t[0] === "Overdue" && t[1] > 0 ? CR_COLORS.danger : CR_COLORS.ink);
      doc.text(String(t[1]), tx, 96);
      doc.setFontSize(7.5);
      doc.setTextColor.apply(doc, CR_COLORS.muted);
      doc.text(t[0].toUpperCase(), tx, 108);
    });

    crHeading(doc, "Work orders opened and completed, by month", 136);
    var y2;
    if (!s.opened12 && !s.completed12) {
      doc.setFontSize(9);
      doc.setTextColor.apply(doc, CR_COLORS.muted);
      doc.text("No work orders were opened or completed in the last 12 months.", 40, 154);
      doc.setTextColor.apply(doc, CR_COLORS.ink);
      y2 = 160;
    } else {
    crLegend(doc, 370, 136);
    crDrawChart(doc, s, 40, 148, 532, 140);
    y2 = crTable(doc, 306, [""].concat(s.months.map(function(m, i) { return crMonthLabel(m, i === 0 || m.slice(5) === "01"); })),
      [["Opened"].concat(s.months.map(function(m) { return s.byMonth[m].opened; })),
       ["Completed"].concat(s.months.map(function(m) { return s.byMonth[m].completed; }))],
      { styles: { fontSize: 7, cellPadding: 2.5, halign: "center", textColor: CR_COLORS.ink, lineColor: CR_COLORS.grid, lineWidth: 0.5 },
        headStyles: { fillColor: [245, 239, 230], textColor: CR_COLORS.muted, fontStyle: "normal" },
        columnStyles: { 0: { halign: "left", fontStyle: "bold" } } });
    }

    // Left column: busiest rooms. Right column: PM, room turns, compliance, CapEx.
    var colY = y2 + 26;
    crHeading(doc, "Busiest rooms (last 12 months)", colY);
    var leftEnd = crTable(doc, colY + 8, ["Room / location", "Requests", "Most recent"],
      s.busiest.length ? s.busiest.map(function(r) { return [r.room, r.count, new Date(r.last).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })]; })
                       : [["No room-specific requests", "", ""]],
      { tableWidth: 250, columnStyles: { 1: { halign: "center" } } });

    doc.setFontSize(11);
    doc.setFont(undefined, "bold");
    doc.setTextColor.apply(doc, CR_COLORS.accent);
    doc.text("Maintenance, compliance and CapEx", 312, colY);
    doc.setFont(undefined, "normal");
    var rightEnd = crTable(doc, colY + 8, ["", ""], [
      ["PM rounds completed (12 mo)", s.pmDone12],
      ["PM done on or before its due date", crPct(s.pmOnTime, s.pmDone12)],
      ["PM overdue right now", s.pmOverdue],
      ["Room turns completed (12 mo)", s.rtDone12],
      ["Room turns open", s.rtOpen],
      ["Compliance items open", s.compOpen],
      ["Compliance overdue", s.compOverdue.length],
      ["Compliance due in the next 30 days", s.compSoon],
      [s.year + " CapEx budget", s.budget === null ? "Not set" : crMoney(s.budget)],
      [s.year + " CapEx spent", crMoney(s.spent) + (s.budget ? " (" + crPct(s.spent, s.budget) + ")" : "")],
      ["Projects active / completed in " + s.year, s.projectsActive + " / " + s.projectsDone]
    ], { showHead: "never", margin: { left: 312, right: 40 }, columnStyles: { 1: { halign: "right", cellWidth: 70 } } });

    if (s.compOverdue.length) {
      var oy = Math.max(leftEnd, rightEnd) + 26;
      crHeading(doc, "Overdue compliance items", oy);
      crTable(doc, oy + 8, ["Item", "Due", "Days overdue"], s.compOverdue.slice(0, 12).map(function(t) {
        return [(t.room && t.room !== "General" ? t.room + " — " : "") + (t.title || ""), t.due_date, daysBetween(t.due_date, s.today)];
      }), { columnStyles: { 1: { cellWidth: 70 }, 2: { halign: "center", cellWidth: 70 } } });
    }
  });

  // Page numbers.
  var pages = doc.getNumberOfPages();
  for (var p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, CR_COLORS.muted);
    doc.text(companyName + " · StoneAnchor summary · page " + p + " of " + pages, 40, 770);
  }
  return doc.output("blob");
}
