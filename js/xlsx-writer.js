// Builds a simple, tidy Excel (.xlsx) file: one sheet, a bold header row that
// stays put when scrolling (with filter arrows), columns sized to fit, and
// real dates and numbers rather than text — so it opens the same way in Excel
// on any computer or phone, unlike a CSV file, where Excel has to guess.
//
// Used in two places, so the downloaded file and the monthly email attachment
// always match:
//   - the browser: js/workorders.js ("Download history" button)
//   - the server: supabase/functions/work-order-stats (monthly email)
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
//   "text", "int", "dec1" (one decimal place), or "date" (a "YYYY-MM-DD" string)
// rows: arrays of values in the same order as columns; null/"" = empty cell.

function buildXlsxWorkbook(JSZip, sheetName, columns, rows) {
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
  var STYLE = { header: 1, date: 2, dec1: 3 };

  function cell(ref, value, type) {
    if (value === null || value === undefined || value === "") return "";
    if (type === "date") return '<c r="' + ref + '" s="' + STYLE.date + '"><v>' + dateSerial(value) + '</v></c>';
    if (type === "int" || type === "dec1") {
      return '<c r="' + ref + '"' + (type === "dec1" ? ' s="' + STYLE.dec1 + '"' : '') + '><v>' + Number(value) + '</v></c>';
    }
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
  }

  var lastCol = colLetter(columns.length - 1);
  var lastRow = rows.length + 1;

  var sheetRows = '<row r="1">' + columns.map(function(c, i) {
    return '<c r="' + colLetter(i) + '1" t="inlineStr" s="' + STYLE.header + '"><is><t>' + esc(c.header) + '</t></is></c>';
  }).join("") + '</row>';
  rows.forEach(function(r, ri) {
    var n = ri + 2;
    sheetRows += '<row r="' + n + '">' + columns.map(function(c, i) { return cell(colLetter(i) + n, r[i], c.type); }).join("") + '</row>';
  });

  var sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:' + lastCol + lastRow + '"/>' +
      '<sheetViews><sheetView workbookViewId="0" tabSelected="1">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + columns.map(function(c, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 12) + '" customWidth="1"/>';
      }).join("") + '</cols>' +
      '<sheetData>' + sheetRows + '</sheetData>' +
      '<autoFilter ref="A1:' + lastCol + lastRow + '"/>' +
    '</worksheet>';

  var styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="ddd mmm d, yyyy"/><numFmt numFmtId="165" formatCode="0.0"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF1"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // Sheet names: at most 31 characters, and none of : \ / ? * [ ]
  var safeName = esc(String(sheetName).replace(/[:\\\/?*\[\]]/g, " ").slice(0, 31) || "Sheet1");

  var zip = new JSZip();
  zip.file("[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');
  zip.file("_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  zip.file("xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + safeName + '" sheetId="1" r:id="rId1"/></sheets>' +
      '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + safeName.replace(/'/g, "''") + '\'!$A$1:$' + lastCol + '$' + lastRow + '</definedName></definedNames>' +
    '</workbook>');
  zip.file("xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');
  zip.file("xl/worksheets/sheet1.xml", sheet);
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
globalThis.workOrderHistoryXlsx = workOrderHistoryXlsx;
