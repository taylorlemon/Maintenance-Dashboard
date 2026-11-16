// Builds a simple, tidy Excel (.xlsx) file: a bold header row that stays put
// when scrolling (with filter arrows), columns sized to fit, and real dates and
// numbers rather than text — so it opens the same way in Excel on any computer
// or phone, unlike a CSV file, where Excel has to guess.
//
// Used in these places:
//   - the browser: js/workorders.js ("Download history" button)
//   - the server: supabase/functions/work-order-stats (monthly email), so the
//     downloaded file and the monthly email attachment always match
//   - the browser: js/capex.js ("Export Expenses", several sheets)
// Written as a plain script (no import/export) so the page can load it with a
// <script> tag; the server imports it for its side effect of setting
// globalThis.buildXlsxWorkbook.
//
// An .xlsx file is a zip of a few XML files; JSZip (already used elsewhere on
// the page) is passed in to do the zipping. The caller turns the result into
// a file with zip.generateAsync({ type: "blob", compression: "DEFLATE" }) in
// the browser, or { type: "base64", compression: "DEFLATE" } for an email
// attachment (without "DEFLATE" the file comes out several times larger).
//
// columns: [{ header, width, type }] — type is one of
//   "text", "int", "dec1" (one decimal place), "money" ($1,234.56), or
//   "date" (a "YYYY-MM-DD" string)
// rows: arrays of values in the same order as columns; null/"" = empty cell.

// One sheet.
function buildXlsxWorkbook(JSZip, sheetName, columns, rows) {
  return buildXlsxWorkbookSheets(JSZip, [{ name: sheetName, columns: columns, rows: rows }]);
}

// Several sheets (tabs) in one file. Each sheet is
// { name, columns, rows, filter, filterRows, boldRows }:
//   filter   — false leaves out the filter arrows (default: on)
//   filterRows — see below; leave out to cover every row
//   boldRows — row positions (0 = first row under the header) to show in
//              bold, e.g. totals. A null entry in `rows` makes an empty row.
function buildXlsxWorkbookSheets(JSZip, sheets) {
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Column number -> Excel letters (0 -> A, 25 -> Z, 26 -> AA).
  function colLetter(i) {
    var s = "";
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // Excel stores dates as a count of days since Dec 30, 1899.
  function dateSerial(ymd) {
    var p = String(ymd).split("-");
    return (Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000;
  }

  // Style numbers below refer to the <cellXfs> list in styles.xml.
  var STYLE = { header: 1, date: 2, dec1: 3, money: 4, bold: 5, boldMoney: 6 };

  function cell(ref, value, type, bold) {
    if (value === null || value === undefined || value === "") return "";
    if (type === "date") return '<c r="' + ref + '" s="' + STYLE.date + '"><v>' + dateSerial(value) + '</v></c>';
    if (type === "money") return '<c r="' + ref + '" s="' + (bold ? STYLE.boldMoney : STYLE.money) + '"><v>' + Number(value) + '</v></c>';
    if (type === "int" || type === "dec1") {
      var s = type === "dec1" ? STYLE.dec1 : (bold ? STYLE.bold : 0);
      return '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + '><v>' + Number(value) + '</v></c>';
    }
    return '<c r="' + ref + '" t="inlineStr"' + (bold ? ' s="' + STYLE.bold + '"' : '') + '><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
  }

  // Sheet names: at most 31 characters, none of : \ / ? * [ ], no repeats.
  var usedNames = {};
  function safeSheetName(name, i) {
    var n = String(name || "").replace(/[:\\\/?*\[\]]/g, " ").slice(0, 31) || ("Sheet" + (i + 1));
    while (usedNames[n.toLowerCase()]) n = n.slice(0, 28) + " " + (i + 1);
    usedNames[n.toLowerCase()] = true;
    return n;
  }

  var built = sheets.map(function(sh, si) {
    var columns = sh.columns, rows = sh.rows;
    var bold = {};
    (sh.boldRows || []).forEach(function(r) { bold[r] = true; });
    var lastCol = colLetter(columns.length - 1);
    var lastRow = rows.length + 1;
    var filter = sh.filter !== false;
    // filterRows: how many rows the filter arrows (and sorting) cover, so a
    // totals row underneath stays put. Default: all of them.
    var filterLastRow = (sh.filterRows != null ? sh.filterRows : rows.length) + 1;

    var sheetRows = '<row r="1">' + columns.map(function(c, i) {
      return '<c r="' + colLetter(i) + '1" t="inlineStr" s="' + STYLE.header + '"><is><t>' + esc(c.header) + '</t></is></c>';
    }).join("") + '</row>';
    rows.forEach(function(r, ri) {
      var n = ri + 2;
      sheetRows += '<row r="' + n + '">' + columns.map(function(c, i) {
        return cell(colLetter(i) + n, r ? r[i] : null, c.type, bold[ri]);
      }).join("") + '</row>';
    });

    var xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="A1:' + lastCol + lastRow + '"/>' +
        '<sheetViews><sheetView workbookViewId="0"' + (si === 0 ? ' tabSelected="1"' : '') + '>' +
          '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
          '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
        '</sheetView></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="15"/>' +
        '<cols>' + columns.map(function(c, i) {
          return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 12) + '" customWidth="1"/>';
        }).join("") + '</cols>' +
        '<sheetData>' + sheetRows + '</sheetData>' +
        (filter ? '<autoFilter ref="A1:' + lastCol + filterLastRow + '"/>' : '') +
      '</worksheet>';
    return { name: safeSheetName(sh.name, si), xml: xml, filter: filter, filterRef: "$A$1:$" + lastCol + "$" + filterLastRow };
  });

  var styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="3"><numFmt numFmtId="164" formatCode="ddd mmm d, yyyy"/><numFmt numFmtId="165" formatCode="0.0"/>' +
        '<numFmt numFmtId="166" formatCode="&quot;$&quot;#,##0.00"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF1"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="7">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="166" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  var zip = new JSZip();
  zip.file("[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      built.map(function(b, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');
  zip.file("_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  var definedNames = built.map(function(b, i) {
    if (!b.filter) return "";
    return '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + esc(b.name).replace(/'/g, "''") + '\'!' + b.filterRef + '</definedName>';
  }).join("");
  zip.file("xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + built.map(function(b, i) {
        return '<sheet name="' + esc(b.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join("") + '</sheets>' +
      (definedNames ? '<definedNames>' + definedNames + '</definedNames>' : '') +
    '</workbook>');
  zip.file("xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      built.map(function(b, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join("") +
      '<Relationship Id="rId' + (built.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');
  built.forEach(function(b, i) { zip.file("xl/worksheets/sheet" + (i + 1) + ".xml", b.xml); });
  zip.file("xl/styles.xml", styles);
  return zip;
}

// Work order history columns — shared by the download button and the monthly
// email so both files have the same layout. `names` maps facility code ->
// facility name; rows are saved work_order_daily_stats rows (with
// property_code on each).
var WORK_ORDER_HISTORY_COLUMNS = [
  { header: "Facility Code", width: 10, type: "text" },
  { header: "Facility", width: 24, type: "text" },
  { header: "Date", width: 17, type: "date" },
  { header: "Added", width: 9, type: "int" },
  { header: "Completed", width: 11, type: "int" },
  { header: "Open at End of Day", width: 11, type: "int" },
  { header: "Overdue at End of Day", width: 11, type: "int" },
  { header: "Avg Days to Complete", width: 11, type: "dec1" },
  { header: "Source", width: 30, type: "text" }
];

function workOrderHistoryXlsx(JSZip, sheetName, names, rows) {
  return buildXlsxWorkbook(JSZip, sheetName, WORK_ORDER_HISTORY_COLUMNS, rows.map(function(r) {
    return [
      r.property_code, names[r.property_code] || "", r.stat_date, r.added, r.completed, r.open_count, r.overdue_count,
      r.completed > 0 ? Math.round(Number(r.completed_days_total) / r.completed * 10) / 10 : null,
      r.is_estimate ? "Rebuilt from Asana (estimate)" : "Recorded that day"
    ];
  }));
}

globalThis.buildXlsxWorkbook = buildXlsxWorkbook;
globalThis.buildXlsxWorkbookSheets = buildXlsxWorkbookSheets;
globalThis.workOrderHistoryXlsx = workOrderHistoryXlsx;
