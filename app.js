"use strict";

const EXP = ["Продукты", "Хозтовары и бытовая химия", "Кафе и доставка", "Аптека и здоровье", "Транспорт и топливо",
  "Одежда и обувь", "Дом и ремонт", "Связь и подписки", "Дети", "Животные", "Красота и уход", "Развлечения", "Другое"];
const FOOD = ["Молочное и яйца", "Мясо и птица", "Рыба и морепродукты", "Овощи", "Фрукты и ягоды", "Хлеб и выпечка",
  "Крупы, макароны, мука", "Бакалея и консервы", "Масло, соусы, специи", "Сладости и снеки", "Чай и кофе", "Напитки",
  "Алкоголь", "Готовая еда", "Замороженное"];
const CURS = ["₽", "֏", "$", "€", "₸", "₴", "Br", "₾", "сўм"];
const MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-5-mini"];
const DEFAULT_MODEL = "gpt-4o-mini";
const NO_SPLIT = "Без разбивки";
const MAX_IMAGES = 4;

const S = {
  budget: null, receipts: [], settings: { apiKey: "", model: DEFAULT_MODEL },
  editBudget: false, open: null, confirmDel: null, draft: null, sheet: null, ctl: null, storeOk: true
};

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = n => Math.round((+n || 0) * 100) / 100;
const cur = () => S.budget?.currency || "₽";
const money = v => nf.format(r2(v)) + " " + cur();
const num = v => { const n = parseFloat(String(v ?? "").replace(/[\s ]/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const toIn = n => (n === "" || n == null) ? "" : String(r2(n)).replace(".", ",");
const today = () => new Date().toLocaleDateString("sv-SE");
const parseD = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const fmtD = s => s ? parseD(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "—";
const isoD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const blankItem = () => ({ name: "", price: "", category: "Продукты", type: "" });

let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3000);
}
function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

/* ---------- storage: localStorage for settings, IndexedDB for receipts and photos ---------- */
function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }

const DB = new Promise((res, rej) => {
  try {
    const r = indexedDB.open("cheki", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("receipts", { keyPath: "id" });
      d.createObjectStore("photos", { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  } catch (e) { rej(e); }
});
DB.catch(() => {});

function tx(stores, mode, fn) {
  return DB.then(d => new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const allReceipts = () => tx("receipts", "readonly", t => t.objectStore("receipts").getAll());
const putReceipt = r => tx("receipts", "readwrite", t => t.objectStore("receipts").put(r));
const putPhoto = (id, blob) => tx("photos", "readwrite", t => t.objectStore("photos").put({ id, blob }));
const getPhoto = id => tx("photos", "readonly", t => t.objectStore("photos").get(id));
function deleteReceipt(r) {
  return tx(["receipts", "photos"], "readwrite", t => {
    t.objectStore("receipts").delete(r.id);
    for (const p of r.photos || []) t.objectStore("photos").delete(p);
  });
}

async function reload() {
  const list = await allReceipts();
  list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
  S.receipts = list;
  render();
}

const photoUrls = new Map();
async function photoUrl(id) {
  if (photoUrls.has(id)) return photoUrls.get(id);
  const rec = await getPhoto(id).catch(() => null);
  const url = rec?.blob ? URL.createObjectURL(rec.blob) : "";
  photoUrls.set(id, url);
  return url;
}
function fillPhotos(root) {
  root.querySelectorAll("img[data-photo]").forEach(async img => {
    const u = await photoUrl(img.dataset.photo);
    if (u) img.src = u; else img.alt = "Фото не найдено";
  });
}

/* ---------- totals ---------- */
function stats() {
  const start = S.budget?.startDate;
  const rs = S.receipts.filter(r => !start || (r.date || "") >= start);
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
}

function renderBudget(st) {
  const el = $("budgetCard"), b = S.budget;
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
  const c0 = b?.currency || "₽";
  return `
    <div class="slip-head"><span class="eyebrow">${b ? "Изменить бюджет" : "Начните с бюджета"}</span></div>
    <form id="budgetForm" class="bform">
      <label for="bDate">Дата старта<input type="date" id="bDate" required value="${esc(b?.startDate || today())}"></label>
      <label for="bAmt">Сумма на старте<input id="bAmt" inputmode="decimal" required placeholder="50 000" value="${b ? esc(toIn(b.startAmount)) : ""}"></label>
      <label for="bCur">Валюта<select id="bCur">${CURS.map(c => `<option ${c === c0 ? "selected" : ""}>${c}</option>`).join("")}</select></label>
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
  $("rcount").textContent = S.receipts.length ? `${S.receipts.length} шт.` : "";
  if (!S.receipts.length) {
    el.innerHTML = `<div class="empty-state">
      <strong>Пока нет ни одного чека</strong>
      <span>Нажмите «Сфотографировать чек». ИИ прочитает магазин, дату, позиции и итог, разложит покупки по видам затрат и продуктов, а вы проверите всё перед сохранением. Длинный чек можно снять в несколько фото через «Загрузить фото».</span>
      ${S.settings.apiKey ? "" : '<button class="btn small" type="button" data-act="settings">Добавить ключ OpenAI</button>'}
    </div>`;
    return;
  }
  const start = S.budget?.startDate;
  el.innerHTML = S.receipts.map(r => {
    const open = S.open === r.id;
    const before = start && (r.date || "") < start;
    return `<article class="rc">
      <button class="rc-row" type="button" data-act="toggle" data-id="${esc(r.id)}" aria-expanded="${open}">
        <span class="rc-date">${fmtD(r.date)}</span>
        <span class="rc-store">${esc(r.store || "Без названия")}${before ? '<span class="tag">до старта</span>' : ""}</span>
        <span class="rc-n">${(r.items || []).length} поз.</span>
        <span class="rc-total num">${money(r.total)}</span>
      </button>
      ${open ? detail(r) : ""}
    </article>`;
  }).join("");
  fillPhotos(el);
}

function detail(r) {
  const items = r.items || [];
  const sum = r2(items.reduce((s, i) => s + (+i.price || 0), 0));
  const diff = r2((+r.total || 0) - sum);
  const sure = S.confirmDel === r.id;
  return `<div class="rc-detail">
    ${(r.photos || []).length ? `<div class="photos">${r.photos.map(id => `<img data-photo="${esc(id)}" data-act="zoom" alt="Фото чека">`).join("")}</div>` : ""}
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
      <button class="btn small danger ${sure ? "sure" : ""}" type="button" data-act="${sure ? "del-yes" : "del"}" data-id="${esc(r.id)}">${sure ? "Да, удалить чек" : "Удалить"}</button>
      ${sure ? `<button class="btn small ghost" type="button" data-act="del-no">Отмена</button>` : ""}
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
  S.ctl?.abort();
  (S.draft?.previews || []).forEach(u => URL.revokeObjectURL(u));
  S.draft = null; S.sheet = null; S.returnTo = null;
  $("sheetWrap").hidden = true;
  document.body.classList.remove("lock");
}

function renderSheet() {
  const d = S.draft, el = $("sheet");
  if (!d) return;
  const thumbs = [
    ...(d.photos || []).map(id => `<img data-photo="${esc(id)}" alt="Фото чека">`),
    ...(d.previews || []).map(u => `<img src="${esc(u)}" alt="Фото чека">`)
  ].join("");
  if (d.state === "reading") {
    el.innerHTML = `
      <header class="sh-head"><h2>Читаю чек</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
      <div class="thumbs">${thumbs}</div>
      <div class="reading"><span class="spin" aria-hidden="true"></span><span class="muted">ИИ разбирает позиции и категории. Обычно это 5–30 секунд.</span></div>
      <div class="row"><button class="btn ghost" type="button" data-act="stop">Остановить и ввести вручную</button></div>`;
    fillPhotos(el);
    return;
  }
  el.innerHTML = `
    <header class="sh-head"><h2>${d.id ? "Изменить чек" : "Новый чек"}</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    ${d.msg ? `<p class="notice">${esc(d.msg)}</p>` : ""}
    ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}
    ${d.files?.length && (d.failed || d.needKey) ? `<div class="row">
      ${d.needKey ? '<button class="btn small" type="button" data-act="settings">Добавить ключ OpenAI</button>' : ""}
      ${S.settings.apiKey ? '<button class="btn small" type="button" data-act="retry">Распознать ещё раз</button>' : ""}
    </div>` : ""}
    <div class="fields">
      <label for="dStore">Магазин<input id="dStore" value="${esc(d.store)}" placeholder="Например, Пятёрочка" autocomplete="off"></label>
      <label for="dDate">Дата покупки<input type="date" id="dDate" value="${esc(d.date)}"></label>
    </div>
    <div class="ihead"><span>Позиция</span><span>Вид затрат</span><span>Вид продукта</span><span>Сумма</span><span></span></div>
    <div id="irows">${d.items.map(rowHtml).join("")}</div>
    <div><button class="btn ghost small" type="button" data-act="add-row">+ Добавить позицию</button></div>
    <div class="totals">
      <div><span>Сумма позиций</span><strong class="num" id="iSum"></strong></div>
      <label class="tot" for="dTotal">Итого по чеку<input id="dTotal" inputmode="decimal" value="${esc(d.total)}" placeholder="0,00"></label>
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
      <h3>Распознавание чеков (OpenAI)</h3>
      <label for="sKey">Ключ OpenAI API
        <span class="keyrow">
          <input type="password" id="sKey" autocomplete="off" spellcheck="false" placeholder="${s.apiKey ? "Ключ сохранён. Вставьте новый, чтобы заменить" : "sk-..."}">
          <button class="btn small ghost" type="button" data-act="key-show">Показать</button>
        </span>
      </label>
      <p class="hint">Ключ хранится только в этом браузере на этом устройстве и отправляется напрямую в OpenAI. В код сайта и на GitHub он не попадает. Поставьте месячный лимит расходов в кабинете OpenAI (Billing → Limits).</p>
      <label for="sModel">Модель<input id="sModel" list="modelList" value="${esc(s.model || DEFAULT_MODEL)}" autocomplete="off" spellcheck="false"></label>
      <datalist id="modelList">${MODELS.map(m => `<option value="${m}"></option>`).join("")}</datalist>
      <div class="row">
        <button class="btn primary" type="submit">Сохранить</button>
        ${s.apiKey ? '<button class="btn ghost danger" type="button" data-act="key-clear">Удалить ключ</button>' : ""}
      </div>
    </form>
    <div class="rule"></div>
    <h3>Данные</h3>
    <p class="hint">Чеки и фото хранятся в этом браузере. На другом устройстве будет свой список. Чтобы перенести данные или сохранить их на всякий случай, скачайте резервную копию и загрузите её на другом устройстве.</p>
    <div class="row">
      <button class="btn" type="button" data-act="export">Скачать резервную копию</button>
      <button class="btn" type="button" data-act="import">Загрузить копию</button>
    </div>`;
}

/* ---------- OpenAI ---------- */
function receiptPrompt() {
  return `Перед тобой фото кассового чека. Если фото несколько, это части одного длинного чека по порядку.
Верни только JSON такого вида:
{"store": "Название магазина", "date": "YYYY-MM-DD", "total": 1234.5, "items": [{"name": "Молоко 3,2% 1 л", "price": 89.9, "category": "Продукты", "type": "Молочное и яйца"}]}

Правила:
- store: короткое название магазина или заведения, как его называют люди (без ООО/ИП, адреса и ИНН).
- date: дата покупки из чека в формате YYYY-MM-DD; если не читается, null. Сегодня ${today()}.
- items: каждая строка товара или услуги. price — итоговая сумма по строке с учётом количества и скидки на строку, числом. name — понятное короткое название на русском без артикулов и кодов; если количество больше одного, допиши «×N».
- category: строго одно значение из списка: ${EXP.join("; ")}.
- type: вид продукта. Для еды и напитков строго одно значение из списка: ${FOOD.join("; ")}. Для остального — короткий общий вид в 1–3 слова, например «Моющие средства», «Лекарства», «Бензин», «Корм».
- Если в чеке есть общая скидка, оплата бонусами или округление, добавь отдельную строку с отрицательной price (name «Скидка»), category и type как у большей части покупок, чтобы сумма всех price равнялась total.
- total: сумма к оплате по чеку, числом.
- Если на фото не чек или его невозможно прочитать, верни {"error": "коротко, что не так"}.`;
}

const blobToDataURL = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); });

async function askOpenAI(files, signal) {
  const images = await Promise.all(files.map(blobToDataURL));
  const body = {
    model: S.settings.model || DEFAULT_MODEL,
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: [{ type: "text", text: receiptPrompt() }, ...images.map(url => ({ type: "image_url", image_url: { url, detail: "high" } }))]
    }]
  };
  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + S.settings.apiKey },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e?.name === "AbortError") throw { code: "cancelled" };
    throw { code: "network" };
  }
  const j = await resp.json().catch(() => null);
  if (!resp.ok) throw { code: "http", status: resp.status, message: j?.error?.message || resp.statusText };
  const text = j?.choices?.[0]?.message?.content || "";
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw { code: "bad_json" };
}

function aiErr(e) {
  if (e?.code === "cancelled") return "Распознавание остановлено. Заполните позиции вручную.";
  if (e?.code === "network") return "Нет связи с OpenAI. Проверьте интернет (в некоторых странах OpenAI доступен только через VPN) и нажмите «Распознать ещё раз».";
  if (e?.code === "bad_json") return "Не получилось прочитать чек. Снимите его ближе и ровнее или заполните позиции вручную.";
  if (e?.code === "http") {
    if (e.status === 401) return "OpenAI не принял ключ. Проверьте его в настройках.";
    if (e.status === 429) return "OpenAI отказал: закончились средства на балансе или превышен лимит запросов. Пополните баланс или подождите минуту.";
    if (e.status === 400 || e.status === 404) return `OpenAI вернул ошибку: ${e.message}. Если дело в модели, выберите другую в настройках.`;
    return `OpenAI временно недоступен (${e.status}). Попробуйте ещё раз чуть позже.`;
  }
  return "Что-то пошло не так. Заполните позиции вручную или попробуйте ещё раз.";
}

function itemFromAI(it) {
  return {
    name: String(it?.name || "").trim(),
    price: toIn(num(it?.price)),
    category: EXP.includes(it?.category) ? it.category : "Другое",
    type: String(it?.type || "").trim()
  };
}

async function recognize(d) {
  d.state = "reading"; d.msg = ""; d.failed = false; d.needKey = false;
  renderSheet();
  const ctl = new AbortController(); S.ctl = ctl;
  try {
    const res = await askOpenAI(d.files.slice(0, MAX_IMAGES), ctl.signal);
    if (S.draft !== d) return;
    if (!res || typeof res !== "object" || res.error) {
      d.failed = true;
      d.msg = `Не похоже на чек${res?.error ? ": " + res.error : ""}. Снимите ещё раз или заполните вручную.`;
    } else {
      d.store = String(res.store || "").trim();
      d.date = isoD(res.date) ? res.date : today();
      d.items = Array.isArray(res.items) ? res.items.map(itemFromAI).filter(i => i.name || num(i.price)) : [];
      d.total = res.total != null && isFinite(+res.total) ? toIn(+res.total) : "";
      d.msg = d.items.length ? "Проверьте позиции и категории, затем сохраните." : "Позиции не распознались. Заполните их вручную.";
    }
  } catch (e) {
    if (S.draft !== d) return;
    d.failed = e?.code !== "cancelled";
    d.msg = aiErr(e);
  }
  if (!d.items.length) d.items = [blankItem()];
  d.state = "edit";
  renderSheet();
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
  if (!list.length) return;
  const files = await Promise.all(list.slice(0, MAX_IMAGES).map(shrink));
  if (list.length > MAX_IMAGES) toast(`Взяты первые ${MAX_IMAGES} фото`);
  const d = { store: "", date: today(), total: "", items: [], photos: [], files, previews: files.map(f => URL.createObjectURL(f)), state: "edit" };
  if (S.settings.apiKey) { openDraft(d); recognize(d); }
  else {
    d.items = [blankItem()];
    d.needKey = true;
    d.msg = "Чтобы чек распознавался сам, добавьте ключ OpenAI в настройках. Или заполните позиции вручную, фото сохранится с чеком.";
    openDraft(d);
  }
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
  try {
    for (const f of d.files || []) { const pid = uid(); await putPhoto(pid, f); d.photos.push(pid); }
    d.files = [];
    const now = new Date().toISOString();
    const id = d.id || uid();
    await putReceipt({
      id, store: String(d.store || "").trim(), date: isoD(d.date) ? d.date : today(), total, items,
      photos: d.photos || [], createdAt: d.createdAt || now, updatedAt: now
    });
    S.open = id;
    closeSheet();
    await reload();
    toast("Чек сохранён");
  } catch (e) {
    d.msg = e?.name === "QuotaExceededError"
      ? "В браузере закончилось место. Удалите старые чеки или скачайте копию и очистите данные."
      : "Не удалось сохранить чек в браузере. Попробуйте ещё раз.";
    renderSheet();
  }
}

function downloadFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportData() {
  const photos = {};
  for (const r of S.receipts) for (const p of r.photos || []) {
    const rec = await getPhoto(p).catch(() => null);
    if (rec?.blob) photos[p] = await blobToDataURL(rec.blob);
  }
  const data = { app: "cheki", version: 1, exportedAt: new Date().toISOString(), budget: S.budget, receipts: S.receipts, photos };
  downloadFile(`cheki-${today()}.json`, JSON.stringify(data));
  toast("Резервная копия скачана");
}

async function importData(e) {
  const f = e.target.files?.[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data?.app !== "cheki" || !Array.isArray(data.receipts)) throw new Error("format");
    for (const [id, url] of Object.entries(data.photos || {})) {
      const blob = await (await fetch(url)).blob();
      await putPhoto(id, blob);
    }
    for (const r of data.receipts) if (r?.id) await putReceipt(r);
    if (data.budget && !S.budget) { S.budget = data.budget; lsSet("budget", S.budget); }
    closeSheet();
    await reload();
    toast(`Загружено чеков: ${data.receipts.length}`);
  } catch {
    toast("Не получилось прочитать файл. Нужна резервная копия, скачанная с этого сайта.");
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
    case "toggle": S.open = S.open === id ? null : id; S.confirmDel = null; renderList(); break;
    case "edit": {
      const r = S.receipts.find(x => x.id === id); if (!r) return;
      const items = (r.items || []).map(i => ({ name: i.name, price: toIn(i.price), category: i.category, type: i.type || "" }));
      openDraft({
        id: r.id, store: r.store || "", date: r.date || today(), total: toIn(r.total), createdAt: r.createdAt,
        items: items.length ? items : [blankItem()], photos: [...(r.photos || [])], files: [], previews: [], state: "edit"
      });
      break;
    }
    case "del": S.confirmDel = id; renderList(); break;
    case "del-no": S.confirmDel = null; renderList(); break;
    case "del-yes": {
      const r = S.receipts.find(x => x.id === id); if (!r) return;
      t.disabled = true;
      try {
        await deleteReceipt(r);
        S.confirmDel = null; S.open = null;
        await reload();
        toast("Чек удалён");
      } catch { toast("Не удалось удалить чек"); t.disabled = false; }
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
    case "settings":
      if (S.sheet === "receipt" && d) { S.returnTo = d; }
      openSheet("settings");
      break;
    case "key-show": { const k = $("sKey"); k.type = k.type === "password" ? "text" : "password"; t.textContent = k.type === "password" ? "Показать" : "Скрыть"; break; }
    case "key-clear":
      S.settings.apiKey = ""; lsSet("settings", S.settings); renderSettings(); toast("Ключ удалён из браузера");
      break;
    case "export": exportData(); break;
    case "import": $("impIn").click(); break;
    case "close":
      if (S.sheet === "settings" && S.returnTo) { S.draft = S.returnTo; S.returnTo = null; openSheet("receipt"); }
      else closeSheet();
      break;
    case "stop": S.ctl?.abort(); break;
    case "retry": if (d) recognize(d); break;
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
  if (S.sheet && S.draft?.state !== "reading") closeSheet();
});

document.addEventListener("submit", e => {
  e.preventDefault();
  if (e.target.id === "budgetForm") {
    const amt = r2(num($("bAmt").value));
    const date = $("bDate").value;
    if (!isoD(date) || !(amt > 0)) { toast("Укажите дату и сумму больше нуля"); return; }
    S.budget = { startDate: date, startAmount: amt, currency: $("bCur").value };
    if (!lsSet("budget", S.budget)) toast("Браузер не дал сохранить бюджет");
    S.editBudget = false; $("budgetCard").innerHTML = "";
    render(); toast("Бюджет сохранён");
  }
  if (e.target.id === "setForm") {
    const key = $("sKey").value.trim();
    if (key) S.settings.apiKey = key;
    S.settings.model = $("sModel").value.trim() || DEFAULT_MODEL;
    lsSet("settings", S.settings);
    toast("Настройки сохранены");
    if (S.returnTo) {
      const d = S.returnTo; S.returnTo = null; S.draft = d; openSheet("receipt");
      if (S.settings.apiKey && d.files?.length) recognize(d);
    } else { closeSheet(); render(); }
  }
});

$("camBtn").onclick = $("fab").onclick = () => $("camIn").click();
$("galBtn").onclick = () => $("galIn").click();
$("camIn").onchange = onFiles;
$("galIn").onchange = onFiles;
$("impIn").onchange = importData;
$("manualBtn").onclick = () => openDraft({ store: "", date: today(), total: "", items: [blankItem()], photos: [], files: [], previews: [], state: "edit" });
$("setBtn").onclick = () => openSheet("settings");

/* ---------- boot ---------- */
S.budget = lsGet("budget", null);
S.settings = { ...S.settings, ...lsGet("settings", {}) };
render();
navigator.storage?.persist?.().catch(() => {});
reload().catch(() => {
  notice("Браузер не даёт сохранять данные (возможно, включён приватный режим). Чеки не сохранятся после закрытия вкладки.");
});
