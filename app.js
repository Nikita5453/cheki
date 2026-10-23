"use strict";

const EXP = ["Продукты", "Хозтовары и бытовая химия", "Кафе и доставка", "Аптека и здоровье", "Транспорт и топливо",
  "Одежда и обувь", "Дом и ремонт", "Связь и подписки", "Дети", "Животные", "Красота и уход", "Развлечения", "Другое"];
const FOOD = ["Молочное и яйца", "Мясо и птица", "Рыба и морепродукты", "Овощи", "Фрукты и ягоды", "Хлеб и выпечка",
  "Крупы, макароны, мука", "Бакалея и консервы", "Масло, соусы, специи", "Сладости и снеки", "Чай и кофе", "Напитки",
  "Алкоголь", "Готовая еда", "Замороженное"];
const CUR = "₴";
const DEFAULT_REPO = "Nikita5453/cheki-data";
const NO_SPLIT = "Без разбивки";
const MAX_IMAGES = 4;

const S = {
  data: { budget: null, receipts: [] }, conn: null, settings: { token: "", repo: DEFAULT_REPO },
  state: "setup", // setup | loading | ready | error
  editBudget: false, open: null, confirmDel: null, draft: null, sheet: null, busy: false
};

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = n => Math.round((+n || 0) * 100) / 100;
const money = v => nf.format(r2(v)) + " " + CUR;
const num = v => { const n = parseFloat(String(v ?? "").replace(/[\s ]/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const toIn = n => (n === "" || n == null) ? "" : String(r2(n)).replace(".", ",");
const today = () => new Date().toLocaleDateString("sv-SE");
const parseD = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const fmtD = s => s ? parseD(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "—";
const isoD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const blankItem = () => ({ name: "", price: "", category: "Продукты", type: "" });
const isDone = r => !r.status || r.status === "done";

let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200);
}
function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }

function ghErr(e) {
  if (e?.status === 0) return "Нет связи с GitHub. Проверьте интернет.";
  if (e?.status === 401) return "GitHub не принял токен. Проверьте его в настройках.";
  if (e?.status === 403) return "У токена нет прав на запись. Нужен доступ Contents: Read and write.";
  if (e?.status === 404) return "Репозиторий с данными не найден или токен не даёт к нему доступа.";
  if (e?.status === 409) return "Данные одновременно изменились на другом устройстве. Попробуйте ещё раз.";
  return "GitHub вернул ошибку: " + (e?.message || "неизвестно");
}

/* ---------- data ---------- */
function receipts() {
  return [...S.data.receipts].sort((a, b) =>
    (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function refresh(quiet) {
  if (!S.conn) return;
  try {
    const { data, changed } = await S.conn.load();
    S.data = data;
    if (S.state !== "ready") { S.state = "ready"; notice(""); }
    if (changed || !quiet) render();
  } catch (e) {
    if (!quiet || S.state !== "ready") { S.state = "error"; notice(ghErr(e)); render(); }
  }
}

async function save(fn, message) {
  S.data = await S.conn.mutate(fn, message);
  render();
}

function connect() {
  const { token, repo } = S.settings;
  if (!token) { S.conn = null; S.state = "setup"; render(); return; }
  S.conn = GH.connect({ token, repo: repo || DEFAULT_REPO });
  S.state = "loading";
  render();
  refresh(false);
}

/* While a receipt waits for recognition, check often; otherwise rarely. 304 answers are free. */
let pollT;
function schedulePoll() {
  clearTimeout(pollT);
  const waiting = S.data.receipts.some(r => r.status === "pending");
  pollT = setTimeout(async () => {
    if (document.visibilityState === "visible" && !S.busy) await refresh(true);
    schedulePoll();
  }, waiting ? 15000 : 90000);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(true); });

const photoUrls = new Map();
async function photoUrl(path) {
  if (photoUrls.has(path)) return photoUrls.get(path);
  const p = S.conn ? S.conn.getPhoto(path).then(b => URL.createObjectURL(b)).catch(() => "") : Promise.resolve("");
  photoUrls.set(path, p);
  return p;
}
function fillPhotos(root) {
  root.querySelectorAll("img[data-photo]").forEach(async img => {
    const u = await photoUrl(img.dataset.photo);
    if (u) img.src = u; else img.alt = "Фото не загрузилось";
  });
}

/* ---------- totals ---------- */
function stats() {
  const start = S.data.budget?.startDate;
  const rs = S.data.receipts.filter(r => isDone(r) && (!start || (r.date || "") >= start));
  let spent = 0;
  const cat = new Map(), typ = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const r of rs) {
    const total = +r.total || 0;
    spent += total;
    let sum = 0;
    for (const it of r.items || []) {
      const p = +it.price || 0;
      sum += p;
      const c = EXP.includes(it.category) ? it.category : "Другое";
      add(cat, c, p);
      add(typ, String(it.type || "").trim() || c, p);
    }
    const diff = r2(total - sum);
    if (Math.abs(diff) >= 0.01) { add(cat, NO_SPLIT, diff); add(typ, NO_SPLIT, diff); }
  }
  const sorted = m => [...m].filter(e => Math.abs(e[1]) >= 0.005).sort((a, b) => b[1] - a[1]);
  let types = sorted(typ);
  if (types.length > 14) {
    const rest = types.slice(13).reduce((s, e) => s + e[1], 0);
    types = [...types.slice(0, 13), ["Остальное", rest]];
  }
  return { rs, spent: r2(spent), cat: sorted(cat), typ: types };
}

/* ---------- render ---------- */
function render() {
  const st = stats();
  renderBudget(st);
  $("byCat").innerHTML = bars(st.cat);
  $("byType").innerHTML = bars(st.typ);
  renderList();
  const ok = S.state === "ready" && !S.busy;
  for (const id of ["camBtn", "galBtn", "manualBtn", "fab"]) $(id).disabled = !ok;
  schedulePoll();
}

function renderBudget(st) {
  const el = $("budgetCard"), b = S.data.budget;
  if (S.state === "setup") {
    el.innerHTML = `<div class="slip-head"><span class="eyebrow">Подключение</span></div>
      <p class="hint">Чеки хранятся в вашем приватном репозитории на GitHub. Чтобы сайт мог их читать и сохранять, один раз добавьте токен доступа на этом устройстве.</p>
      <div><button class="btn primary" type="button" data-act="settings">Подключить хранилище</button></div>`;
    return;
  }
  if (S.state === "loading") { el.innerHTML = `<div class="slip-head"><span class="eyebrow">Бюджет</span></div><p class="muted">Загружаю данные…</p>`; return; }
  if (S.state === "error") {
    el.innerHTML = `<div class="slip-head"><span class="eyebrow">Бюджет</span></div><p class="hint">Данные не загрузились.</p>
      <div class="row"><button class="btn small" type="button" data-act="reload">Повторить</button><button class="btn small ghost" type="button" data-act="settings">Настройки</button></div>`;
    return;
  }
  if (!b || S.editBudget) {
    if (!$("budgetForm")) el.innerHTML = budgetForm(b);
    return;
  }
  const start = +b.startAmount || 0;
  const left = r2(start - st.spent);
  const pct = start > 0 ? st.spent / start * 100 : 0;
  const days = Math.max(1, Math.round((parseD(today()) - parseD(b.startDate)) / 864e5) + 1);
  const avg = st.spent / days;
  let forecast = "";
  if (avg > 0 && left > 0) {
    const end = parseD(today()); end.setDate(end.getDate() + Math.floor(left / avg));
    forecast = `При таком темпе хватит до ${end.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`;
  } else if (left <= 0 && st.spent > 0) forecast = "Бюджет израсходован";
  el.innerHTML = `
    <div class="slip-head"><span class="eyebrow">Бюджет</span><button class="link" data-act="edit-budget" type="button">Изменить</button></div>
    <dl class="lines">
      <div><dt>Старт</dt><dd>${fmtD(b.startDate)}</dd></div>
      <div><dt>Сумма на старте</dt><dd>${money(start)}</dd></div>
      <div><dt>Потрачено</dt><dd>${money(st.spent)}</dd></div>
    </dl>
    <div class="rule"></div>
    <div class="left ${left < 0 ? "over" : ""}"><span>${left < 0 ? "Перерасход" : "Остаток"}</span><strong>${money(Math.abs(left))}</strong></div>
    <div class="meter ${left < 0 ? "over" : ""}" role="img" aria-label="Израсходовано ${Math.round(pct)}%"><i style="width:${Math.min(100, pct)}%"></i></div>
    <p class="meter-cap">Израсходовано ${Math.round(pct)}%</p>
    <div class="rule"></div>
    <dl class="lines">
      <div><dt>Дней с начала</dt><dd>${days}</dd></div>
      <div><dt>В среднем за день</dt><dd>${money(avg)}</dd></div>
      <div><dt>Чеков в бюджете</dt><dd>${st.rs.length}</dd></div>
    </dl>
    ${forecast ? `<p class="forecast">${esc(forecast)}</p>` : ""}`;
}

function budgetForm(b) {
  return `
    <div class="slip-head"><span class="eyebrow">${b ? "Изменить бюджет" : "Начните с бюджета"}</span></div>
    <form id="budgetForm" class="bform">
      <label for="bDate">Дата старта<input type="date" id="bDate" required value="${esc(b?.startDate || today())}"></label>
      <label for="bAmt">Сумма на старте, ₴<input id="bAmt" inputmode="decimal" required placeholder="20 000" value="${b ? esc(toIn(b.startAmount)) : ""}"></label>
      <div class="row">
        <button class="btn primary" type="submit">Сохранить</button>
        ${b ? '<button class="btn ghost" type="button" data-act="cancel-budget">Отмена</button>' : ""}
      </div>
    </form>`;
}

function bars(entries) {
  if (!entries.length) return `<p class="empty">Появится после первого чека.</p>`;
  const max = Math.max(...entries.map(e => Math.abs(e[1])));
  const tot = entries.reduce((s, e) => s + e[1], 0);
  return `<ol class="bars">${entries.map(([k, v]) => `
    <li class="${v < 0 ? "neg" : ""}">
      <div class="bl"><span>${esc(k)}</span><span class="num">${money(v)} <em>${tot > 0 ? Math.round(v / tot * 100) : 0}%</em></span></div>
      <div class="bt"><i style="width:${max > 0 ? Math.max(1.5, Math.abs(v) / max * 100) : 0}%"></i></div>
    </li>`).join("")}</ol>`;
}

function renderList() {
  const el = $("list");
  const list = receipts();
  const waiting = list.filter(r => r.status === "pending").length;
  $("rcount").textContent = list.length ? `${list.length} шт.${waiting ? ` · ждут распознавания: ${waiting}` : ""}` : "";
  if (S.state !== "ready") { el.innerHTML = `<p class="empty">${S.state === "loading" ? "Загружаю чеки…" : "Чеки появятся после подключения хранилища."}</p>`; return; }
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <strong>Пока нет ни одного чека</strong>
      <span>Нажмите «Сфотографировать чек». Фото уйдёт в очередь, и Claude на вашем компьютере прочитает магазин, дату, позиции и итог, разложит покупки по видам затрат и продуктов. Длинный чек можно снять в несколько фото через «Загрузить фото».</span>
    </div>`;
    return;
  }
  const start = S.data.budget?.startDate;
  el.innerHTML = list.map(r => {
    const open = S.open === r.id;
    const before = isDone(r) && start && (r.date || "") < start;
    const tag = r.status === "pending" ? '<span class="tag wait">ждёт распознавания</span>'
      : r.status === "error" ? '<span class="tag err">не распознан</span>'
      : before ? '<span class="tag">до старта</span>' : "";
    const title = isDone(r) ? (r.store || "Без названия") : "Новый чек";
    return `<article class="rc">
      <button class="rc-row" type="button" data-act="toggle" data-id="${esc(r.id)}" aria-expanded="${open}">
        <span class="rc-date">${fmtD(r.date)}</span>
        <span class="rc-store">${esc(title)}${tag}</span>
        <span class="rc-n">${isDone(r) ? (r.items || []).length + " поз." : ""}</span>
        <span class="rc-total num">${isDone(r) ? money(r.total) : "—"}</span>
      </button>
      ${open ? detail(r) : ""}
    </article>`;
  }).join("");
  fillPhotos(el);
}

function detail(r) {
  const sure = S.confirmDel === r.id;
  const photos = (r.photos || []).length ? `<div class="photos">${r.photos.map(p => `<img data-photo="${esc(p)}" data-act="zoom" alt="Фото чека">`).join("")}</div>` : "";
  const delBtns = `
      <button class="btn small danger ${sure ? "sure" : ""}" type="button" data-act="${sure ? "del-yes" : "del"}" data-id="${esc(r.id)}">${sure ? "Да, удалить чек" : "Удалить"}</button>
      ${sure ? `<button class="btn small ghost" type="button" data-act="del-no">Отмена</button>` : ""}`;
  if (r.status === "pending" || r.status === "error") {
    return `<div class="rc-detail">
      ${photos}
      <p class="hint">${r.status === "pending"
        ? "Чек распознается, когда на компьютере запущено «Распознавание чеков». Можно не ждать и заполнить его вручную."
        : "Claude не смог прочитать этот чек: " + esc(r.error || "причина неизвестна") + ". Попробуйте ещё раз или заполните вручную."}</p>
      <div class="row">
        ${r.status === "error" ? `<button class="btn small" type="button" data-act="retry" data-id="${esc(r.id)}">Распознать ещё раз</button>` : ""}
        <button class="btn small" type="button" data-act="edit" data-id="${esc(r.id)}">Заполнить вручную</button>
        ${delBtns}
      </div>
    </div>`;
  }
  const items = r.items || [];
  const sum = r2(items.reduce((s, i) => s + (+i.price || 0), 0));
  const diff = r2((+r.total || 0) - sum);
  return `<div class="rc-detail">
    ${photos}
    <div class="items"><table>
      <thead><tr><th>Позиция</th><th>Вид затрат</th><th>Вид продукта</th><th class="num">Сумма</th></tr></thead>
      <tbody>
        ${items.map(i => `<tr><td>${esc(i.name)}</td><td class="sub2">${esc(i.category)}</td><td class="sub2">${esc(i.type || "—")}</td><td class="num">${money(i.price)}</td></tr>`).join("")}
        ${Math.abs(diff) >= 0.01 ? `<tr><td class="sub2" colspan="3">${NO_SPLIT} (разница с итогом)</td><td class="num">${money(diff)}</td></tr>` : ""}
        <tr><td colspan="3"><strong>Итого</strong></td><td class="num"><strong>${money(r.total)}</strong></td></tr>
      </tbody>
    </table></div>
    <div class="row">
      <button class="btn small" type="button" data-act="edit" data-id="${esc(r.id)}">Изменить</button>
      ${delBtns}
    </div>
  </div>`;
}

/* ---------- sheet (receipt editor and settings) ---------- */
function openSheet(kind) {
  S.sheet = kind;
  $("sheetWrap").hidden = false;
  document.body.classList.add("lock");
  kind === "settings" ? renderSettings() : renderSheet();
}
function openDraft(d) { S.draft = d; openSheet("receipt"); }
function closeSheet() {
  S.draft = null; S.sheet = null;
  $("sheetWrap").hidden = true;
  document.body.classList.remove("lock");
}

function renderSheet() {
  const d = S.draft, el = $("sheet");
  if (!d) return;
  const thumbs = (d.photos || []).map(p => `<img data-photo="${esc(p)}" alt="Фото чека">`).join("");
  el.innerHTML = `
    <header class="sh-head"><h2>${d.isNew ? "Новый чек" : "Чек"}</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    ${d.msg ? `<p class="notice">${esc(d.msg)}</p>` : ""}
    ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}
    <div class="fields">
      <label for="dStore">Магазин<input id="dStore" value="${esc(d.store)}" placeholder="Например, Сільпо" autocomplete="off"></label>
      <label for="dDate">Дата покупки<input type="date" id="dDate" value="${esc(d.date)}"></label>
    </div>
    <div class="ihead"><span>Позиция</span><span>Вид затрат</span><span>Вид продукта</span><span>Сумма, ₴</span><span></span></div>
    <div id="irows">${d.items.map(rowHtml).join("")}</div>
    <div><button class="btn ghost small" type="button" data-act="add-row">+ Добавить позицию</button></div>
    <div class="totals">
      <div><span>Сумма позиций</span><strong class="num" id="iSum"></strong></div>
      <label class="tot" for="dTotal">Итого по чеку, ₴<input id="dTotal" inputmode="decimal" value="${esc(d.total)}" placeholder="0,00"></label>
      <p class="diff" id="iDiff"></p>
    </div>
    <div class="row end">
      <button class="btn ghost" type="button" data-act="close">Отмена</button>
      <button class="btn primary" type="button" data-act="save" id="saveBtn">Сохранить чек</button>
    </div>
    <datalist id="typeList">${FOOD.map(t => `<option value="${esc(t)}"></option>`).join("")}</datalist>`;
  fillPhotos(el);
  updateSums();
}

function rowHtml(it, i) {
  return `<div class="irow" data-i="${i}">
    <input class="i-name" data-f="name" value="${esc(it.name)}" placeholder="Название" aria-label="Название позиции">
    <select class="i-cat" data-f="category" aria-label="Вид затрат">${EXP.map(c => `<option ${c === it.category ? "selected" : ""}>${c}</option>`).join("")}</select>
    <input class="i-type" data-f="type" list="typeList" value="${esc(it.type)}" placeholder="Вид продукта" aria-label="Вид продукта">
    <input class="i-price" data-f="price" inputmode="decimal" value="${esc(it.price)}" placeholder="0,00" aria-label="Сумма">
    <button class="i-del" type="button" data-act="del-row" data-i="${i}" aria-label="Убрать позицию">×</button>
  </div>`;
}

function updateSums() {
  const d = S.draft; if (!d || !$("iSum")) return;
  const sum = r2(d.items.reduce((s, i) => s + num(i.price), 0));
  $("iSum").textContent = money(sum);
  const hasTotal = String(d.total).trim() !== "";
  const diff = r2(num(d.total) - sum);
  $("iDiff").textContent = !hasTotal ? "Если итог не указан, сохранится сумма позиций."
    : Math.abs(diff) >= 0.01 ? `Разница с итогом ${money(diff)} попадёт в «${NO_SPLIT}».` : "Сумма позиций совпадает с итогом.";
}

function renderSettings() {
  const s = S.settings;
  $("sheet").innerHTML = `
    <header class="sh-head"><h2>Настройки</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    <form id="setForm" class="bform">
      <h3>Хранилище на GitHub</h3>
      <p class="hint">Чеки и фото лежат в приватном репозитории <b>${esc(s.repo || DEFAULT_REPO)}</b>. Чтобы сайт мог с ним работать, на каждом устройстве один раз вставьте токен доступа.</p>
      <ol class="hint steps">
        <li>Откройте <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → новый fine-grained токен</a>.</li>
        <li>Token name: <i>чеки</i>. Expiration: <i>No expiration</i> или год.</li>
        <li>Repository access: <i>Only select repositories</i> → <i>cheki-data</i>.</li>
        <li>Permissions → Repository permissions → <i>Contents</i>: <i>Read and write</i>.</li>
        <li>Нажмите Generate token, скопируйте его и вставьте сюда.</li>
      </ol>
      <label for="sToken">Токен GitHub
        <span class="keyrow">
          <input type="password" id="sToken" autocomplete="off" spellcheck="false" placeholder="${s.token ? "Токен сохранён. Вставьте новый, чтобы заменить" : "github_pat_..."}">
          <button class="btn small ghost" type="button" data-act="key-show">Показать</button>
        </span>
      </label>
      <p class="hint">Токен хранится только в этом браузере. Он даёт доступ лишь к репозиторию с чеками.</p>
      <label for="sRepo">Репозиторий с данными<input id="sRepo" value="${esc(s.repo || DEFAULT_REPO)}" autocomplete="off" spellcheck="false"></label>
      <p class="hint" id="setMsg"></p>
      <div class="row">
        <button class="btn primary" type="submit" id="setSave">Сохранить и проверить</button>
        ${s.token ? '<button class="btn ghost danger" type="button" data-act="key-clear">Отключить это устройство</button>' : ""}
      </div>
    </form>`;
}

/* ---------- photos in, receipts out ---------- */
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close?.();
    const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.85));
    return blob || file;
  } catch { return file; }
}

async function onFiles(e) {
  const list = [...(e.target.files || [])];
  e.target.value = "";
  if (!list.length || S.state !== "ready") return;
  if (list.length > MAX_IMAGES) toast(`Взяты первые ${MAX_IMAGES} фото`);
  S.busy = true; render();
  notice("Отправляю фото чека…");
  const id = uid(), paths = [];
  try {
    const files = await Promise.all(list.slice(0, MAX_IMAGES).map(shrink));
    for (let i = 0; i < files.length; i++) {
      const path = `photos/${id}-${i + 1}.jpg`;
      await S.conn.putPhoto(path, files[i]);
      paths.push(path);
    }
    const now = new Date().toISOString();
    await save(d => {
      d.receipts.push({ id, status: "pending", date: today(), store: "", total: 0, items: [], photos: paths, createdAt: now, updatedAt: now });
    }, "Новый чек в очереди");
    S.open = id;
    notice("");
    toast("Чек в очереди на распознавание");
  } catch (err) {
    for (const p of paths) S.conn.deleteFile(p).catch(() => {});
    notice(ghErr(err));
  }
  S.busy = false; render();
}

async function saveDraft() {
  const d = S.draft; if (!d) return;
  const items = d.items
    .filter(it => String(it.name).trim() || num(it.price))
    .map(it => ({
      name: String(it.name).trim() || "Позиция",
      price: r2(num(it.price)),
      category: EXP.includes(it.category) ? it.category : "Другое",
      type: String(it.type || "").trim()
    }));
  const sum = r2(items.reduce((s, i) => s + i.price, 0));
  const total = String(d.total).trim() !== "" ? r2(num(d.total)) : sum;
  if (!items.length && !total) { d.msg = "Добавьте хотя бы одну позицию или итог по чеку."; renderSheet(); return; }
  const btn = $("saveBtn"); btn.disabled = true; btn.textContent = "Сохраняю…";
  const now = new Date().toISOString();
  const rec = {
    id: d.id, status: "done", store: String(d.store || "").trim(), date: isoD(d.date) ? d.date : today(), total, items,
    photos: d.photos || [], createdAt: d.createdAt || now, updatedAt: now
  };
  try {
    await save(data => {
      const i = data.receipts.findIndex(r => r.id === rec.id);
      if (i >= 0) data.receipts[i] = rec; else data.receipts.push(rec);
    }, `Чек: ${rec.store || "без названия"}, ${rec.total} ₴`);
    S.open = rec.id;
    closeSheet();
    render();
    toast("Чек сохранён");
  } catch (e) {
    d.msg = ghErr(e);
    renderSheet();
  }
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  const d = S.draft;
  switch (act) {
    case "edit-budget": S.editBudget = true; $("budgetCard").innerHTML = ""; render(); break;
    case "cancel-budget": S.editBudget = false; $("budgetCard").innerHTML = ""; render(); break;
    case "reload": connect(); break;
    case "toggle": S.open = S.open === id ? null : id; S.confirmDel = null; renderList(); break;
    case "edit": {
      const r = S.data.receipts.find(x => x.id === id); if (!r) return;
      const items = (r.items || []).map(i => ({ name: i.name, price: toIn(i.price), category: i.category, type: i.type || "" }));
      openDraft({
        id: r.id, store: r.store || "", date: r.date || today(), total: isDone(r) ? toIn(r.total) : "", createdAt: r.createdAt,
        items: items.length ? items : [blankItem()], photos: [...(r.photos || [])], isNew: !isDone(r)
      });
      break;
    }
    case "retry":
      try {
        await save(data => {
          const r = data.receipts.find(x => x.id === id); if (!r) return false;
          r.status = "pending"; delete r.error;
        }, "Повторное распознавание");
        toast("Чек снова в очереди");
      } catch (err) { toast(ghErr(err)); }
      break;
    case "del": S.confirmDel = id; renderList(); break;
    case "del-no": S.confirmDel = null; renderList(); break;
    case "del-yes": {
      const r = S.data.receipts.find(x => x.id === id); if (!r) return;
      t.disabled = true;
      try {
        await save(data => { data.receipts = data.receipts.filter(x => x.id !== id); }, "Удалён чек");
        S.confirmDel = null; S.open = null; render();
        toast("Чек удалён");
        for (const p of r.photos || []) await S.conn.deleteFile(p).catch(() => {});
      } catch (err) { toast(ghErr(err)); t.disabled = false; }
      break;
    }
    case "zoom": {
      if (!t.src) return;
      const v = document.createElement("div");
      v.className = "viewer"; v.innerHTML = `<img src="${esc(t.src)}" alt="Фото чека">`;
      v.onclick = () => v.remove();
      document.body.append(v);
      break;
    }
    case "settings": openSheet("settings"); break;
    case "key-show": { const k = $("sToken"); k.type = k.type === "password" ? "text" : "password"; t.textContent = k.type === "password" ? "Показать" : "Скрыть"; break; }
    case "key-clear":
      S.settings.token = ""; lsSet("settings", S.settings); closeSheet(); connect(); toast("Устройство отключено");
      break;
    case "close": closeSheet(); break;
    case "add-row": if (d) { d.items.push(blankItem()); renderSheet(); $("irows").lastElementChild?.querySelector("input")?.focus(); } break;
    case "del-row": if (d) { d.items.splice(+t.dataset.i, 1); if (!d.items.length) d.items.push(blankItem()); renderSheet(); } break;
    case "save": saveDraft(); break;
  }
});

$("sheet").addEventListener("input", e => {
  const d = S.draft; if (!d || S.sheet !== "receipt") return;
  const t = e.target;
  if (t.dataset.f) { const i = +t.closest(".irow").dataset.i; d.items[i][t.dataset.f] = t.value; }
  else if (t.id === "dStore") d.store = t.value;
  else if (t.id === "dDate") d.date = t.value;
  else if (t.id === "dTotal") d.total = t.value;
  updateSums();
});
$("sheet").addEventListener("change", e => {
  const t = e.target, d = S.draft;
  if (d && S.sheet === "receipt" && t.dataset.f === "category") d.items[+t.closest(".irow").dataset.i].category = t.value;
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const v = document.querySelector(".viewer"); if (v) { v.remove(); return; }
  if (S.sheet) closeSheet();
});

document.addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.id === "budgetForm") {
    const amt = r2(num($("bAmt").value));
    const date = $("bDate").value;
    if (!isoD(date) || !(amt > 0)) { toast("Укажите дату и сумму больше нуля"); return; }
    const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
    try {
      S.editBudget = false;
      await save(data => { data.budget = { startDate: date, startAmount: amt }; }, `Бюджет: ${amt} ₴ с ${date}`);
      $("budgetCard").innerHTML = ""; render();
      toast("Бюджет сохранён");
    } catch (err) { S.editBudget = !!S.data.budget; toast(ghErr(err)); btn.disabled = false; }
  }
  if (e.target.id === "setForm") {
    const token = $("sToken").value.trim() || S.settings.token;
    const repo = $("sRepo").value.trim() || DEFAULT_REPO;
    const msg = $("setMsg"), btn = $("setSave");
    if (!token) { msg.textContent = "Вставьте токен."; return; }
    btn.disabled = true; msg.textContent = "Проверяю доступ…";
    try {
      const info = await GH.connect({ token, repo }).check();
      if (!info.canPush) throw Object.assign(new Error("no push"), { status: 403 });
      S.settings = { token, repo };
      lsSet("settings", S.settings);
      closeSheet();
      connect();
      toast(info.private ? "Хранилище подключено" : "Подключено, но репозиторий публичный: чеки видны всем");
    } catch (err) {
      msg.textContent = ghErr(err);
      btn.disabled = false;
    }
  }
});

$("camBtn").onclick = $("fab").onclick = () => $("camIn").click();
$("galBtn").onclick = () => $("galIn").click();
$("camIn").onchange = onFiles;
$("galIn").onchange = onFiles;
$("manualBtn").onclick = () => openDraft({ id: uid(), store: "", date: today(), total: "", items: [blankItem()], photos: [], isNew: true });
$("setBtn").onclick = () => openSheet("settings");

/* ---------- boot ---------- */
S.settings = { ...S.settings, ...lsGet("settings", {}) };
connect();
