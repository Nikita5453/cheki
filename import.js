"use strict";
/* Загрузка банковской выписки (CSV, Excel) в текущую сборку. Файл разбирается в браузере (statement.js);
   на сервер попадают только траты, которые человек отметил. Каждая трата становится чеком с id «bank-…»,
   который зависит от сборки, даты, времени, суммы и описания: повторная загрузка того же файла не создаёт дублей. */

const XLSX_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
const KIND_TAG = { cash: "снятие наличных", transfer: "перевод", have: "уже загружено", match: "есть чек", before: "до старта" };

let xlsxLoad;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = XLSX_URL;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoad = null; reject(new Error("Не загрузился модуль для Excel. Проверьте интернет или сохраните выписку в CSV.")); };
    document.head.append(s);
  });
  return xlsxLoad;
}

async function readTable(file) {
  const name = file.name.toLowerCase();
  if (/\.pdf$/.test(name)) throw new Error("PDF пока не поддерживается. Скачайте выписку в банке в формате Excel или CSV.");
  const buf = await file.arrayBuffer();
  if (/\.(xlsx?|xlsm|ods)$/.test(name)) {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    /* Берём лист, где нашлась строка заголовков; если такого нет — самый большой. */
    let best = null;
    for (const sn of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: "" }).filter(r => r.some(v => String(v).trim()));
      const found = Statement.detect(rows).header >= 0;
      if (!best || (found && !best.found) || (found === best.found && rows.length > best.rows.length)) best = { rows, found };
    }
    return best ? best.rows : [];
  }
  return Statement.parseCsv(Statement.decode(buf));
}

/* Чек и трата из банка об одной покупке: та же сборка, та же сумма, даты не дальше суток.
   Когда сохраняется или распознаётся чек, такая трата из банка удаляется: чек её заменяет, а позиции есть только в нём.
   Удаляем только то, что человеку разрешено удалять (автор или владелец сборки), иначе база молча ничего не удалит. */
async function replaceBankTwin(rec) {
  if (!rec || isBank(rec) || !isDone(rec) || !(+rec.total > 0) || rec.bookId !== S.bookId || !isoD(rec.date)) return null;
  const gap = b => Math.abs(parseD(b.date) - parseD(rec.date));
  const twin = S.receipts
    .filter(b => isBank(b) && b.bookId === rec.bookId && isoD(b.date) && Math.abs((+b.total || 0) - rec.total) < 0.01 && gap(b) <= 864e5 * 1.5 && canEdit(b))
    .sort((a, b) => gap(a) - gap(b))[0];
  if (!twin) return null;
  try {
    await SB.deleteReceipt(twin.id);
    S.receipts = S.receipts.filter(x => x.id !== twin.id);
    return twin;
  } catch (e) {
    console.warn("replaceBankTwin", e);
    return null;
  }
}
const twinNote = twin => twin ? ` · заменил трату из банка «${twin.store || "операция"}»` : "";

async function sha(text) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

function openImport() {
  if (S.state !== "ready" || !curBook()) { toast(!curBook() ? "Сначала создайте сборку" : "Подождите, данные ещё загружаются"); return; }
  S.imp = { step: "file", bookId: S.bookId };
  openSheet("import");
}

async function onImportFile(file) {
  const m = S.imp;
  m.msg = ""; m.loading = true; renderImport();
  try {
    m.rows = await readTable(file);
    if (!m.rows.length) throw new Error("В файле не нашлось строк.");
    m.fileName = file.name;
    const det = Statement.detect(m.rows);
    m.header = det.header; m.map = det.map; m.sign = "auto";
    if (det.header < 0) m.msg = "Не нашёл в файле заголовки колонок. Укажите ниже, где дата, описание и сумма.";
    await rebuild();
    m.step = "review";
  } catch (e) {
    m.msg = e.message || String(e);
  }
  m.loading = false;
  renderImport();
}

/* Операции из таблицы по текущим колонкам и режиму знака, с отметками «уже загружено», «есть чек» и т. п. */
async function rebuild() {
  const m = S.imp, book = S.books.find(b => b.id === m.bookId);
  const okMap = m.map.date >= 0 && (m.map.amount >= 0 || (m.map.debit >= 0 && m.map.credit >= 0));
  if (!okMap) { m.ops = []; m.income = 0; m.skipped = 0; return; }
  const res = Statement.operations(m.rows, m.header, m.map, m.sign);
  m.income = res.income; m.skipped = res.skipped; m.mode = res.mode;
  const seen = new Map();
  const have = new Set(S.receipts.map(r => r.id));
  const cands = S.receipts.filter(r => isDone(r) && !isBank(r));
  const used = new Set();
  m.ops = [];
  for (const o of res.ops) {
    const key = `${m.bookId}|${o.date}|${o.time}|${o.amount.toFixed(2)}|${o.desc}`;
    const n = (seen.get(key) || 0) + 1; seen.set(key, n);
    const id = "bank-" + await sha(`${key}|${n}`);
    let status = o.kind === "spend" ? "new" : o.kind;
    if (have.has(id)) status = "have";
    else {
      const match = cands.find(r => !used.has(r.id) && Math.abs((+r.total || 0) - o.amount) < 0.01
        && Math.abs(parseD(r.date) - parseD(o.date)) <= 864e5 * 1.5);
      if (match) { used.add(match.id); status = "match"; o.matchStore = match.store; }
      else if (status === "new" && book?.startDate && o.date < book.startDate) status = "before";
    }
    m.ops.push({ ...o, id, status, checked: status === "new", category: Statement.category(o, EXP) });
  }
}

/* «5 нояб.», с годом только если он не текущий: в узкой строке полная дата не помещается. */
function shortD(iso) {
  const d = parseD(iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

function colName(i) {
  const m = S.imp;
  const h = m.header >= 0 ? String(m.rows[m.header][i] ?? "").trim() : "";
  return h || `Колонка ${i + 1}`;
}

function renderImport() {
  const m = S.imp, el = $("sheet"), book = S.books.find(b => b.id === m.bookId);
  if (!m || !book) return closeSheet();
  const head = `<header class="sh-head"><h2>Выписка банка</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    ${m.msg ? `<p class="notice">${esc(m.msg)}</p>` : ""}`;
  if (m.step === "file") {
    el.innerHTML = `${head}
      <p class="hint">Скачайте выписку в приложении или на сайте банка в формате Excel или CSV и выберите файл. Подойдёт выписка любого банка: Монобанк, ПриватБанк, А-Банк и другие.</p>
      <p class="hint">Файл разбирается прямо на этом устройстве. Сначала вы увидите список трат и сами отметите, какие добавить в сборку «${esc(book.name)}». На сервер попадут только отмеченные.</p>
      <div class="row">
        <label class="btn primary ${m.loading ? "off" : ""}" for="impFile" tabindex="0" role="button">${m.loading ? "Читаю файл…" : "Выбрать файл выписки"}</label>
        <input type="file" id="impFile" class="sr" accept=".csv,.xls,.xlsx,.ods,.txt,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" tabindex="-1" aria-hidden="true">
        <button class="btn ghost" type="button" data-act="close">Отмена</button>
      </div>`;
    return;
  }
  const ops = m.ops || [];
  const ncols = Math.max(...m.rows.slice(Math.max(0, m.header), Math.max(0, m.header) + 30).map(r => r.length), 0);
  const sel = (role, label) => `<label for="impMap-${role}">${label}<select id="impMap-${role}" data-imp-map="${role}">
      <option value="-1">— нет —</option>
      ${Array.from({ length: ncols }, (_, i) => `<option value="${i}" ${m.map[role] === i ? "selected" : ""}>${esc(colName(i))}</option>`).join("")}
    </select></label>`;
  const useDebit = m.map.debit >= 0 || m.map.credit >= 0;
  const counts = ops.reduce((a, o) => (a[o.status] = (a[o.status] || 0) + 1, a), {});
  const info = [
    `Трат в файле: ${ops.length}`,
    counts.have ? `уже загружены раньше: ${counts.have}` : "",
    counts.match ? `совпали с чеками в сборке: ${counts.match}` : "",
    m.income ? `поступлений и возвратов пропущено: ${m.income}` : "",
    m.skipped ? `строк без даты или суммы: ${m.skipped}` : ""
  ].filter(Boolean).join(" · ");
  el.innerHTML = `${head}
    <p class="hint"><b>${esc(m.fileName)}</b> → сборка «${esc(book.name)}». ${esc(info)}.</p>
    ${ops.some(o => o.status !== "new" && o.status !== "have") ? `<p class="hint">Траты с пометками «есть чек», «перевод», «снятие наличных» и «до старта» не отмечены, чтобы не посчитать их дважды. Отметьте их, если они нужны.</p>` : ""}
    <details class="impmap" ${m.header < 0 || !ops.length ? "open" : ""}>
      <summary>Колонки файла</summary>
      <div class="impgrid">
        ${sel("date", "Дата")}
        ${sel("desc", "Описание")}
        ${useDebit ? sel("debit", "Списание") + sel("credit", "Зачисление") : sel("amount", "Сумма")}
        ${sel("cat", "Категория банка")}
        ${sel("mcc", "Код MCC")}
        ${useDebit ? "" : `<label for="impSign">Какие суммы — траты<select id="impSign">
          <option value="auto" ${m.sign === "auto" ? "selected" : ""}>Определить само (сейчас: ${m.mode === "all" ? "все суммы" : "со знаком минус"})</option>
          <option value="minus" ${m.sign === "minus" ? "selected" : ""}>Со знаком минус</option>
          <option value="all" ${m.sign === "all" ? "selected" : ""}>Все суммы</option>
        </select></label>`}
      </div>
    </details>
    ${ops.length ? `<div class="row">
      <button class="btn small ghost" type="button" data-act="imp-all">Отметить все</button>
      <button class="btn small ghost" type="button" data-act="imp-new">Только новые</button>
      <button class="btn small ghost" type="button" data-act="imp-none">Снять все</button>
    </div>
    <div class="items imptable"><table>
      <thead><tr><th></th><th>Дата</th><th>Описание</th><th>Вид затрат</th><th class="num">Сумма</th></tr></thead>
      <tbody>${ops.map((o, i) => `<tr class="${o.status === "have" ? "dim" : ""}">
        <td class="c-chk"><input type="checkbox" data-imp-row="${i}" ${o.checked ? "checked" : ""} ${o.status === "have" ? "disabled" : ""} aria-label="Добавить: ${esc(o.desc || "операция")} ${esc(money(o.amount))}"></td>
        <td class="c-date sub2 nowrap">${shortD(o.date)}${o.time ? ` <span class="t">${esc(o.time)}</span>` : ""}</td>
        <td class="c-desc">${esc(o.desc || "Без описания")}${KIND_TAG[o.status] ? `<span class="tag">${KIND_TAG[o.status]}</span>` : ""}${o.status === "match" && o.matchStore ? `<br><span class="sub2">чек: ${esc(o.matchStore)}</span>` : ""}</td>
        <td class="c-cat"><select data-imp-cat="${i}" aria-label="Вид затрат" ${o.status === "have" ? "disabled" : ""}>${EXP.map(c => `<option ${c === o.category ? "selected" : ""}>${c}</option>`).join("")}</select></td>
        <td class="c-sum num">${money(o.amount)}</td>
      </tr>`).join("")}</tbody>
    </table></div>` : `<p class="empty">Трат не нашлось. Проверьте колонки выше.</p>`}
    <div class="totals impfoot"><div><span>Отмечено</span><strong class="num" id="impSum"></strong></div></div>
    <div class="row end">
      <button class="btn ghost" type="button" data-act="imp-back">Другой файл</button>
      <button class="btn primary" type="button" data-act="imp-save" id="impSave"></button>
    </div>`;
  updateImportSum();
}

function updateImportSum() {
  const m = S.imp, chosen = (m.ops || []).filter(o => o.checked);
  const sum = r2(chosen.reduce((s, o) => s + o.amount, 0));
  if ($("impSum")) $("impSum").textContent = `${chosen.length} шт. · ${money(sum)}`;
  const b = $("impSave");
  if (b) { b.disabled = !chosen.length || m.saving; b.textContent = m.saving ? "Добавляю…" : chosen.length ? `Добавить ${chosen.length} в сборку` : "Отметьте траты"; }
}

async function saveImport() {
  const m = S.imp, chosen = m.ops.filter(o => o.checked && o.status !== "have");
  if (!chosen.length) return;
  m.saving = true; updateImportSum();
  const recs = chosen.map(o => {
    const name = (o.desc || "Операция по карте").slice(0, 120);
    return { id: o.id, bookId: m.bookId, status: "done", date: o.date, store: name.slice(0, 80), total: o.amount,
      items: [{ name, price: o.amount, category: EXP.includes(o.category) ? o.category : "Другое", type: "" }], photos: [], manual: false };
  });
  try {
    for (let i = 0; i < recs.length; i += 200) await SB.insertReceipts(recs.slice(i, i + 200));
    const book = S.books.find(b => b.id === m.bookId);
    closeSheet();
    await refresh(true);
    toast(`Добавлено трат из выписки: ${recs.length}${book ? " · " + book.name : ""}`);
  } catch (e) {
    m.saving = false; m.msg = errText(e);
    renderImport();
  }
}

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act^='imp-']"); if (!t || S.sheet !== "import") return;
  const m = S.imp;
  switch (t.dataset.act) {
    case "imp-all": m.ops.forEach(o => { if (o.status !== "have") o.checked = true; }); renderImport(); break;
    case "imp-new": m.ops.forEach(o => { o.checked = o.status === "new"; }); renderImport(); break;
    case "imp-none": m.ops.forEach(o => { o.checked = false; }); renderImport(); break;
    case "imp-back": S.imp = { step: "file", bookId: m.bookId }; renderImport(); break;
    case "imp-save": saveImport(); break;
  }
});

$("sheet").addEventListener("change", async e => {
  if (S.sheet !== "import") return;
  const t = e.target, m = S.imp;
  if (t.id === "impFile") { const f = t.files?.[0]; t.value = ""; if (f) onImportFile(f); return; }
  if (t.dataset.impRow != null) { m.ops[+t.dataset.impRow].checked = t.checked; updateImportSum(); return; }
  if (t.dataset.impCat != null) { m.ops[+t.dataset.impCat].category = t.value; return; }
  if (t.dataset.impMap) { m.map[t.dataset.impMap] = +t.value; m.msg = ""; await rebuild(); renderImport(); return; }
  if (t.id === "impSign") { m.sign = t.value; await rebuild(); renderImport(); }
});

$("sheet").addEventListener("keydown", e => {
  if (S.sheet === "import" && e.target.matches("label[for='impFile']") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.target.click(); }
});

$("importBtn").onclick = openImport;
