/* Daily Expenses Bot - Financial Dashboard
 * Plain HTML/CSS/JS. Fetches the published Google Sheets CSV and computes the
 * financial-month budget logic (ported from the Obsidian DataviewJS note, but
 * adapted to read from the Google Sheets CSV that the bot actually writes to).
 *
 * Differences from the Obsidian note (which read markdown lists via dv.pages()):
 *   - Data source is the published CSV (columns: Date, Amount, Currency,
 *     Description, Category, Payment Method, Raw Text, Created At).
 *   - Salary/payday are editable in the UI and persisted to localStorage.
 *   - Robust quoted-CSV + date parsing.
 */

"use strict";

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

var CATEGORIES = {
  "استثمار": 0.25,   // Investment
  "طوارئ": 0.15,     // Emergency
  "ادخار": 0.15,     // Savings
  "أكل": 0.15,       // Food
  "مواصلات": 0.05,   // Transport
  "رفاهيات": 0.10,   // Luxury / Entertainment
  "ملابس": 0.05,     // Clothing
  "مرافق": 0.05,     // Utilities
  "إنترنت": 0.05     // Internet
};

var DEFAULTS = {
  salary: 20000,
  payday: 25,
  csvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSrdzW7MfR2brytkTH_x2wx9_5vSxIlktNng6XBIjpfNwEKip1C450EV9yWDLu_ui3kzDtk6sM0p1F7/pub?output=csv"
};

var LS_KEY_DEFAULTS = "de_dashboard_defaults";     // { salary, payday }
var LS_KEY_OVERRIDES = "de_dashboard_overrides";   // { "YYYY-MM": {salary?, payday?} }
var LS_KEY_MONTH = "de_dashboard_month";           // last viewed "YYYY-MM"

var state = {
  rows: [],            // parsed expense rows
  loading: true,
  error: null,
  currentMonth: null,  // "YYYY-MM" being viewed
};

var momentCache = {};  // not needed; we avoid moment and use local helpers.

var el = {};

/* ------------------------------------------------------------------ */
/*  Small date helpers (replaces moment usage from the Obsidian note)  */
/* ------------------------------------------------------------------ */

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function addDays(d, n) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function diffDays(a, b) {
  var ms = new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
           new Date(a.getFullYear(), a.getMonth(), a.getDate());
  return Math.round(ms / 86400000);
}

function monthKey(d) {
  var m = d.getMonth() + 1;
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m);
}

function monthKeyParts(key) {
  var p = key.split("-");
  return { y: parseInt(p[0], 10), m: parseInt(p[1], 10) };
}

function firstOfMonthKey(key) {
  var p = monthKeyParts(key);
  return new Date(p.y, p.m - 1, 1);
}

function monthName(key) {
  var names = [
    "يناير","فبراير","مارس","أبريل","مايو","يونيو",
    "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"
  ];
  return names[monthKeyParts(key).m - 1];
}

function monthShort(key) {
  var s = ["ينا","فبر","مار","أبر","ماي","يون","يول","أغس","سبت","أكت","نوف","ديس"];
  return s[monthKeyParts(key).m - 1];
}

/* Parse a CSV date that Google Sheets may have stored in various formats.
 * Handles YYYY-MM-DD, M/D/YYYY or D/M/YYYY (ambiguous -> prefer M/D like Sheets
 * en-US), and ISO date-times. Returns a local Date or null. */
function parseCsvDate(value) {
  if (!value) return null;
  var s = String(value).trim();
  if (!s) return null;

  // ISO date-time: "2026-08-27 14:54:43" or "2026-08-27T14:54:43"
  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([T ]|$)/);
  if (iso) {
    var d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  // Serial number from Google Sheets (e.g. 46283). Detect integer in plausible range.
  if (/^\d+$/.test(s)) {
    var n = parseInt(s, 10);
    if (n > 20000 && n < 60000) {
      // Excel serial (1899-12-30 epoch)
      var serialDate = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      var d2 = new Date(serialDate.getUTCFullYear(), serialDate.getUTCMonth(), serialDate.getUTCDate());
      return isNaN(d2.getTime()) ? null : d2;
    }
    return null;
  }

  // Slash format: "8/27/2026" or "27/08/2026"
  var slashed = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashed) {
    var a = parseInt(slashed[1], 10), b = parseInt(slashed[2], 10), y = parseInt(slashed[3], 10);
    if (y < 100) y += 2000;
    // If first part > 12 it must be a day -> [day, month, year]
    if (a > 12) return new Date(y, b - 1, a);
    // Otherwise assume [month, day, year] (Sheets US default)
    if (b > 12) return new Date(y, a - 1, b);
    return new Date(y, a - 1, b);
  }

  var parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/* ------------------------------------------------------------------ */
/*  Financial month config (salary/payday), with per-month overrides   */
/* ------------------------------------------------------------------ */

function defaultConfig() {
  var d = { salary: DEFAULTS.salary, payday: DEFAULTS.payday };
  try {
    var stored = JSON.parse(localStorage.getItem(LS_KEY_DEFAULTS) || "null");
    if (stored) {
      if (stored.salary != null) d.salary = Number(stored.salary);
      if (stored.payday != null) d.payday = Number(stored.payday);
    }
  } catch (e) { /* ignore */ }
  return d;
}

function overrides() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY_OVERRIDES) || "{}");
  } catch (e) {
    return {};
  }
}

function saveOverrides(map) {
  localStorage.setItem(LS_KEY_OVERRIDES, JSON.stringify(map));
}

function getMonthConfig(monthKey) {
  var base = defaultConfig();
  var ov = overrides()[monthKey];
  var salary = ov && ov.salary != null ? Number(ov.salary) : base.salary;
  var payday = ov && ov.payday != null ? Number(ov.payday) : base.payday;
  salary = !isNaN(salary) && salary > 0 ? salary : base.salary;
  payday = !isNaN(payday) && payday >= 1 && payday <= 31 ? payday : base.payday;
  return { salary: salary, payday: payday };
}

// Ported from the Obsidian note: financial month runs from payday of the
// previous calendar month to the day before payday of the current month.
function getFinancialMonthRange(key) {
  var cfg = getMonthConfig(key);
  var m = firstOfMonthKey(key);

  var startDate;
  if (cfg.payday <= 1) {
    startDate = startOfMonth(m);
  } else {
    // day 'cfg.payday' of the previous month
    startDate = new Date(m.getFullYear(), m.getMonth() - 1, cfg.payday);
  }

  var nextKey = monthKey(addMonths(m, 1));
  var nextCfg = getMonthConfig(nextKey);
  var nextStartDate;
  if (nextCfg.payday <= 1) {
    nextStartDate = addMonths(m, 1); // start of next month
  } else {
    nextStartDate = new Date(m.getFullYear(), m.getMonth(), nextCfg.payday);
  }
  var endDate = addDays(nextStartDate, -1);

  return { startDate: startDate, endDate: endDate, config: cfg };
}

function getFinancialMonthForDate(fileDate) {
  if (!fileDate || isNaN(fileDate.getTime())) return null;
  var base = monthKey(fileDate);
  var p = monthKeyParts(base);
  var candidates = [
    monthKey(new Date(p.y, p.m - 2, 1)),
    base,
    monthKey(new Date(p.y, p.m, 1))
  ];
  for (var i = 0; i < candidates.length; i++) {
    var range = getFinancialMonthRange(candidates[i]);
    if (fileDate >= range.startDate && fileDate <= range.endDate) {
      return candidates[i];
    }
  }
  return base;
}

/* ------------------------------------------------------------------ */
/*  CSV parsing (handles quoted fields)                                */
/* ------------------------------------------------------------------ */

function parseCSV(text) {
  var rows = [];
  var field = "", row = [];
  var inQuotes = false;
  var i = 0;
  while (i < text.length) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(function (v) { return v.trim() !== ""; })) rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    i++;
  }
  // last field/row
  row.push(field);
  if (row.some(function (v) { return v.trim() !== ""; })) rows.push(row);
  return rows;
}

function mapRow(row, headerMap) {
  function g(name) {
    var idx = headerMap[String(name).toLowerCase()];
    return idx == null ? "" : (row[idx] == null ? "" : String(row[idx]).trim());
  }
  var amount = parseFloat(g("Amount"));
  var date = parseCsvDate(g("Date"));
  return {
    date: date,
    rawDate: g("Date"),
    amount: isNaN(amount) ? 0 : amount,
    currency: g("Currency") || "EGP",
    description: g("Description"),
    category: g("Category") || "أخرى",
    paymentMethod: g("Payment Method"),
    rawText: g("Raw Text")
  };
}

/* ------------------------------------------------------------------ */
/*  Data loading                                                       */
/* ------------------------------------------------------------------ */

async function loadData() {
  setStatus("جارٍ تحميل البيانات…", "");
  state.loading = true;
  state.error = null;
  try {
    var response = await fetch(DEFAULTS.csvUrl);
    if (!response.ok) throw new Error("Network response was not ok (" + response.status + ")");
    var text = await response.text();
    var rows = parseCSV(text);
    if (rows.length === 0) throw new Error("لا توجد بيانات في ملف CSV");

    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var headerMap = {};
    header.forEach(function (h, idx) { headerMap[h] = idx; });

    var required = ["date", "amount"];
    for (var r = 0; r < required.length; r++) {
      if (headerMap[required[r]] == null) {
        throw new Error("عمود مفقود في البيانات: " + required[r]);
      }
    }

    state.rows = rows.slice(1).map(function (row) { return mapRow(row, headerMap); });
    state.loading = false;
    setStatus("", "");
    renderAll();
  } catch (e) {
    state.loading = false;
    state.error = e.message;
    setStatus("❌ فشل تحميل البيانات: " + e.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/*  Rendering helpers                                                  */
/* ------------------------------------------------------------------ */

function fmt(n) {
  if (n == null || isNaN(n)) return "0";
  return Number(n).toLocaleString("en", { maximumFractionDigits: 2 });
}

function setStatus(msg, cls) {
  var s = document.getElementById("status");
  s.textContent = msg;
  s.className = "status" + (cls ? " " + cls : "");
}

function rowsInMonth(monthKey) {
  return state.rows.filter(function (r) {
    if (!r.date) return false;
    return getFinancialMonthForDate(r.date) === monthKey;
  });
}

function monthBudget(monthKey) {
  var cfg = getMonthConfig(monthKey);
  return cfg.salary * 1;
}

/* ------------------------------------------------------------------ */
/*  KPIs                                                               */
/* ------------------------------------------------------------------ */

function renderKPIs(monthKey, rows, budget) {
  var spent = 0;
  rows.forEach(function (r) { spent += r.amount; });
  var remaining = budget - spent;
  var pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;

  var cls = pct > 100 ? "bad" : (pct > 80 ? "warn" : "good");
  var container = document.getElementById("kpis");
  container.innerHTML =
    kpiCard(budget, "الميزانية (EGP)") +
    kpiCard(spent, "المصروف الفعلي (EGP)", pct > 100 ? "bad" : "good") +
    kpiCard(remaining, "المتبقي (EGP)", remaining < 0 ? "bad" : "good") +
    kpiCard(pct + "%", "نسبة الاستهلاك", cls);
}

function kpiCard(value, label, cls) {
  return '<div class="kpi ' + (cls || "") + '"><div class="value">' + fmt(value) +
         '</div><div class="label">' + label + '</div></div>';
}

/* ------------------------------------------------------------------ */
/*  Latest transactions                                                */
/* ------------------------------------------------------------------ */

function renderTransactions() {
  var tbody = document.querySelector("#transactions-table tbody");
  var sorted = state.rows.slice().sort(function (a, b) {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date - a.date;
  });
  var top = sorted.slice(0, 10);

  tbody.innerHTML = top.map(function (r) {
    var d = r.date ? r.date.toLocaleDateString("en-CA") : r.rawDate;
    return "<tr>" +
      "<td>" + esc(d) + "</td>" +
      '<td class="num">' + fmt(r.amount) + "</td>" +
      "<td>" + esc(r.currency) + "</td>" +
      "<td>" + esc(r.description || "—") + "</td>" +
      "<td>" + esc(r.category) + "</td>" +
      "<td>" + esc(r.paymentMethod || "—") + "</td>" +
      "</tr>";
  }).join("");

  // Non-EGP note
  var nonEGP = state.rows.filter(function (r) {
    return (r.currency || "EGP").toUpperCase() !== "EGP";
  });
  var note = document.getElementById("transactions-note");
  var totalEGP = state.rows.reduce(function (sum, r) {
    return sum + ((r.currency || "EGP").toUpperCase() === "EGP" ? r.amount : 0);
  }, 0);
  note.textContent = "إجمالي المصروف المسجل (EGP): " + fmt(totalEGP) +
    (nonEGP.length ? " — ملاحظة: توجد عمليات بعملات أخرى (" + nonEGP.length + ") لا تدخل في إجمالي EGP." : "");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ */
/*  Monthly budget table                                               */
/* ------------------------------------------------------------------ */

function budgetTable(monthKey, rows) {
  var cfg = getMonthConfig(monthKey);
  var salary = cfg.salary;

  var budgets = {};
  Object.keys(CATEGORIES).forEach(function (c) { budgets[c] = CATEGORIES[c] * salary; });

  var spent = {};
  rows.forEach(function (r) {
    spent[r.category] = (spent[r.category] || 0) + r.amount;
  });

  var totalBudget = 0, totalSpent = 0;
  var bodyRows = Object.keys(budgets).map(function (cat) {
    var budget = budgets[cat];
    var actual = spent[cat] || 0;
    var remaining = budget - actual;
    totalBudget += budget;
    totalSpent += actual;
    return budgetRow(cat, budget, actual, remaining);
  });

  bodyRows.push(
    "<tr class=\"total-row\">" +
    "<td>الإجمالي</td>" +
    '<td class="num">' + fmt(totalBudget) + "</td>" +
    '<td class="num">' + fmt(totalSpent) + "</td>" +
    '<td class="num ' + (totalBudget - totalSpent < 0 ? "neg" : "pos") + '">' + fmt(totalBudget - totalSpent) + "</td>" +
    "<td></td>" +
    "</tr>"
  );

  return { html: bodyRows.join(""), spent: spent, budgets: budgets };
}

function budgetRow(cat, budget, actual, remaining) {
  var pct = budget > 0 ? Math.min(100, Math.round((actual / budget) * 100)) : 0;
  var color = actual > budget ? "#f87171" : (pct > 80 ? "#fbbf24" : "#34d399");
  return "<tr>" +
    "<td>" + esc(cat) + "</td>" +
    '<td class="num">' + fmt(budget) + "</td>" +
    '<td class="num">' + fmt(actual) + "</td>" +
    '<td class="num ' + (remaining < 0 ? "neg" : "") + '">' + fmt(remaining) + "</td>" +
    '<td><div class="progress"><span style="width:' + pct + '%;background:' + color + '"></span></div> ' + pct + "%</td>" +
    "</tr>";
}

function renderMonthlyBudget(monthKey) {
  var rows = rowsInMonth(monthKey);
  var table = budgetTable(monthKey, rows);
  var tbody = document.querySelector("#budget-table tbody");
  tbody.innerHTML = table.html;
}

/* ------------------------------------------------------------------ */
/*  Yearly summary + chart                                             */
/* ------------------------------------------------------------------ */

function yearlyData(year) {
  var nowKey = getFinancialMonthForDate(new Date());
  var nowY = monthKeyParts(nowKey).y;

  var monthlySpent = {};
  state.rows.forEach(function (r) {
    if (!r.date) return;
    var key = getFinancialMonthForDate(r.date);
    if (key && key.startsWith(String(year))) {
      monthlySpent[key] = (monthlySpent[key] || 0) + r.amount;
    }
  });

  var months = [];
  var grandBudget = 0, grandSpent = 0;
  for (var i = 1; i <= 12; i++) {
    var key = year + "-" + (i < 10 ? "0" + i : i);
    // Only include months up to the current financial month of this year
    if (nowY === year && key > nowKey) continue;
    if (nowY > year) continue;
    var cfg = getMonthConfig(key);
    var budget = cfg.salary;
    var spent = monthlySpent[key] || 0;
    months.push({
      key: key,
      name: monthName(key),
      budget: budget,
      spent: spent,
      remaining: budget - spent,
      pct: budget > 0 ? Math.round((spent / budget) * 100) : 0
    });
    grandBudget += budget;
    grandSpent += spent;
  }

  return {
    months: months,
    grandBudget: grandBudget,
    grandSpent: grandSpent,
    grandPct: grandBudget > 0 ? Math.round((grandSpent / grandBudget) * 100) : 0
  };
}

function renderYearly(year) {
  var data = yearlyData(year);
  var tbody = document.querySelector("#yearly-table tbody");

  var bodyRows = data.months.map(function (m) {
    return "<tr>" +
      "<td>" + esc(m.name) + "</td>" +
      '<td class="num">' + fmt(m.budget) + "</td>" +
      '<td class="num">' + fmt(m.spent) + "</td>" +
      '<td class="num ' + (m.remaining < 0 ? "neg" : "") + '">' + fmt(m.remaining) + "</td>" +
      '<td class="num">' + m.pct + "%</td>" +
      "</tr>";
  });

  bodyRows.push(
    "<tr class=\"total-row\">" +
    "<td>الإجمالي السنوي</td>" +
    '<td class="num">' + fmt(data.grandBudget) + "</td>" +
    '<td class="num">' + fmt(data.grandSpent) + "</td>" +
    '<td class="num ' + (data.grandBudget - data.grandSpent < 0 ? "neg" : "pos") + '">' + fmt(data.grandBudget - data.grandSpent) + "</td>" +
    '<td class="num">' + data.grandPct + "%</td>" +
    "</tr>"
  );

  tbody.innerHTML = bodyRows.join("");
  return data;
}

/* ------------------------------------------------------------------ */
/*  SVG bar chart                                                      */
/* ------------------------------------------------------------------ */

function renderChart(year) {
  var data = yearlyData(year);
  var container = document.getElementById("chart");
  var months = data.months;
  if (months.length === 0) {
    container.innerHTML = '<div class="note">لا توجد بيانات للرسم.</div>';
    return;
  }

  var W = 720, H = 320, padL = 70, padR = 20, padT = 25, padB = 40;
  var chartW = W - padL - padR;
  var chartH = H - padT - padB;

  var maxVal = 0;
  months.forEach(function (m) {
    maxVal = Math.max(maxVal, m.budget, m.spent);
  });
  if (maxVal === 0) maxVal = 1;
  maxVal = Math.ceil(maxVal / 5000) * 5000;

  var slot = chartW / months.length;
  var barW = Math.min(34, slot * 0.5);
  var group = Math.min(70, slot - 2);

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';

  // gridlines + y labels
  var gridLines = 5;
  for (var g = 0; g <= gridLines; g++) {
    var yv = maxVal - (maxVal * g / gridLines);
    var y = padT + (chartH * g / gridLines);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y +
           '" stroke="#2a3550" stroke-width="1" stroke-dasharray="3 3"/>';
    svg += '<text x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="#9aa5bd" font-size="11">' +
           fmt(yv) + '</text>';
  }

  // bars
  months.forEach(function (m, idx) {
    var cx = padL + slot * idx + slot / 2;
    var bhBudget = (m.budget / maxVal) * chartH;
    var bhSpent = (m.spent / maxVal) * chartH;

    // spent bar
    var sx = cx - barW;
    var sy = padT + chartH - bhSpent;
    svg += '<rect x="' + sx + '" y="' + sy + '" width="' + barW + '" height="' + bhSpent +
           '" rx="3" fill="rgba(248,113,113,0.75)"><title>' + esc(m.name) + ' المصروف: ' + fmt(m.spent) + '</title></rect>';

    // budget bar
    var bx = cx;
    var by = padT + chartH - bhBudget;
    svg += '<rect x="' + bx + '" y="' + by + '" width="' + barW + '" height="' + bhBudget +
           '" rx="3" fill="rgba(56,189,248,0.4)"><title>' + esc(m.name) + ' الميزانية: ' + fmt(m.budget) + '</title></rect>';

    // x label
    svg += '<text x="' + cx + '" y="' + (H - 12) + '" text-anchor="middle" fill="#9aa5bd" font-size="11">' +
           esc(m.short || monthShort(m.key)) + '</text>';
  });

  // legend
  svg += '<rect x="' + padL + '" y="8" width="10" height="10" fill="rgba(248,113,113,0.75)"/>';
  svg += '<text x="' + (padL + 14) + '" y="17" fill="#9aa5bd" font-size="11">المصروف الفعلي</text>';
  svg += '<rect x="' + (padL + 110) + '" y="8" width="10" height="10" fill="rgba(56,189,248,0.4)"/>';
  svg += '<text x="' + (padL + 124) + '" y="17" fill="#9aa5bd" font-size="11">الميزانية المخططة</text>';

  svg += "</svg>";
  container.innerHTML = svg;
}

/* ------------------------------------------------------------------ */
/*  Month label + header                                               */
/* ------------------------------------------------------------------ */

function renderMonthLabel(monthKey) {
  var cfg = getMonthConfig(monthKey);
  var elLabel = document.getElementById("month-label");
  elLabel.textContent = monthName(monthKey) + " " + monthKeyParts(monthKey).y +
    " (مرتب: " + fmt(cfg.salary) + " | قبض: " + cfg.payday + ")";
}

function loadConfigInputs() {
  var base = defaultConfig();
  el.salaryInput.value = base.salary;
  el.paydayInput.value = base.payday;
}

/* ------------------------------------------------------------------ */
/*  Master render                                                      */
/* ------------------------------------------------------------------ */

function renderAll() {
  var monthKey = state.currentMonth;
  var cfg = getMonthConfig(monthKey);
  var rows = rowsInMonth(monthKey);
  var budget = cfg.salary;
  var year = monthKeyParts(monthKey).y;

  renderMonthLabel(monthKey);
  renderKPIs(monthKey, rows, budget);
  renderTransactions();
  renderMonthlyBudget(monthKey);
  renderYearly(year);
  renderChart(year);

  var sub = document.getElementById("source-label");
  sub.textContent = "الشهر المالي " + monthKey;
}

/* ------------------------------------------------------------------ */
/*  Event wiring + init                                                */
/* ------------------------------------------------------------------ */

function setCurrentMonth(key) {
  state.currentMonth = key;
  try { localStorage.setItem(LS_KEY_MONTH, key); } catch (e) {}
  if (!state.loading) renderAll();
  else renderMonthLabel(key);
}

function initState() {
  var todayKey = getFinancialMonthForDate(new Date());
  // restore last viewed month if valid
  var saved = null;
  try { saved = localStorage.getItem(LS_KEY_MONTH); } catch (e) {}
  state.currentMonth = saved || todayKey;
  // clamp: if saved month is in the future, use today
  if (saved && saved > todayKey) state.currentMonth = todayKey;
}

function init() {
  el.salaryInput = document.getElementById("salary-input");
  el.paydayInput = document.getElementById("payday-input");

  loadConfigInputs();
  initState();

  document.getElementById("prev-month").addEventListener("click", function () {
    var p = monthKeyParts(state.currentMonth);
    setCurrentMonth(monthKey(new Date(p.y, p.m - 2, 1)));
  });
  document.getElementById("next-month").addEventListener("click", function () {
    var p = monthKeyParts(state.currentMonth);
    setCurrentMonth(monthKey(new Date(p.y, p.m, 1)));
  });
  document.getElementById("today-btn").addEventListener("click", function () {
    setCurrentMonth(getFinancialMonthForDate(new Date()));
  });

  // Save default config + per-month override for the viewed month
  document.getElementById("save-config").addEventListener("click", function () {
    var salary = parseFloat(el.salaryInput.value) || DEFAULTS.salary;
    var payday = parseInt(el.paydayInput.value, 10) || DEFAULTS.payday;
    if (payday < 1) payday = 1;
    if (payday > 31) payday = 31;

    // Save as the default config
    try {
      localStorage.setItem(LS_KEY_DEFAULTS, JSON.stringify({ salary: salary, payday: payday }));
    } catch (e) {}

    // Also record a per-month override for the current financial month
    var ov = overrides();
    ov[state.currentMonth] = { salary: salary, payday: payday };
    saveOverrides(ov);

    setStatus("تم حفظ الإعدادات ✓", "");
    setTimeout(function () { if (!state.error) setStatus("", ""); }, 2500);
    if (!state.loading) renderAll();
  });

  renderMonthLabel(state.currentMonth);
  loadData();
}

document.addEventListener("DOMContentLoaded", init);
