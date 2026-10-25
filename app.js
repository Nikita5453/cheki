"use strict";

const PERSONAL = "Личные";
const EXP = ["Продукты", "Хозтовары и бытовая химия", "Кафе и доставка", "Аптека и здоровье", "Транспорт и топливо",
  "Одежда и обувь", "Дом и ремонт", "Связь и подписки", "Дети", "Животные", "Красота и уход", "Развлечения", PERSONAL, "Другое"];
const FOOD = ["Молочное", "Яйца", "Мясо и птица", "Рыба и морепродукты", "Овощи", "Фрукты и ягоды", "Хлеб и выпечка",
  "Крупы, макароны, мука", "Бакалея и консервы", "Масло, соусы, специи", "Сладости и снеки", "Чай и кофе", "Напитки",
  "Алкоголь", "Готовая еда", "Замороженное"];
const CUR = "₴";
const NO_SPLIT = "Без разбивки";
const MAX_IMAGES = 4;

const S = {
  user: null, books: [], bookId: null, receipts: [],
  state: "auth", // auth | loading | ready | error
  open: null, confirmDel: null, draft: null, sheet: null, busy: false, view: null, scope: "month"
};

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = n => Math.round((+n || 0) * 100) / 100;
const money = v => nf.format(r2(v)) + " " + CUR;
const num = v => { const n = parseFloat(String(v ?? "").replace(/[\s ]/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const toIn = n => (n === "" || n == null) ? "" : String(r2(n)).replace(".", ",");
const today = () => new Date().toLocaleDateString("sv-SE");
const parseD = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const fmtD = s => s ? parseD(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "—";
const isoD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const blankItem = () => ({ name: "", price: "", category: "Продукты", type: "" });
const isDone = r => !r.status || r.status === "done";

const curBook = () => S.books.find(b => b.id === S.bookId) || null;
const myId = () => S.user?.id;
const isOwner = (b = curBook()) => !!b && b.members.some(m => m.userId === myId() && m.role === "owner");
const canEdit = r => r.author === myId() || isOwner();
const person = id => curBook()?.members.find(m => m.userId === id);
const personName = id => id === myId() ? "Вы" : (person(id)?.name || person(id)?.email || "Бывший участник");
const firstName = id => id === myId() ? "Вы" : String(personName(id)).split(" ")[0];

let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200);
}
function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

function errText(e) {
  const m = String(e?.message || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Нет связи с сервером. Проверьте интернет.";
  if (/JWT|not signed in|session/i.test(m)) return "Сессия закончилась. Войдите заново.";
  if (/row-level security|permission|violates/i.test(m)) return "Нет прав на это действие. Менять чужие чеки может только их автор или владелец сборки.";
  if (/invite not found/i.test(m)) return "Ссылка-приглашение недействительна. Попросите прислать новую.";
  return "Ошибка: " + (m || "неизвестно");
}

/* ---------- data ---------- */
function receipts() {
  return [...S.receipts].sort((a, b) =>
    (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function loadBooks() {
  S.books = await SB.books();
  if (!S.books.some(b => b.id === S.bookId)) {
    const saved = lsGet("book", "");
    S.bookId = (S.books.find(b => b.id === saved) || S.books[0] || {}).id || null;
  }
}

async function refresh(quiet) {
  if (!S.user) return;
  try {
    if (!quiet || !S.books.length) await loadBooks();
    S.receipts = S.bookId ? await SB.receipts(S.bookId) : [];
    if (S.state !== "ready") { S.state = "ready"; notice(""); }
    render();
  } catch (e) {
    if (!quiet || S.state !== "ready") { S.state = "error"; notice(errText(e)); render(); }
  }
}

function putLocal(rec) {
  const i = S.receipts.findIndex(r => r.id === rec.id);
  if (rec.bookId !== S.bookId) { if (i >= 0) S.receipts.splice(i, 1); return; }
  if (i >= 0) S.receipts[i] = rec; else S.receipts.push(rec);
}

function selectBook(id) {
  if (!S.books.some(b => b.id === id)) return;
  S.bookId = id; lsSet("book", id);
  S.view = null; S.open = null; S.confirmDel = null; S.receipts = [];
  render();
  refresh(true);
}

/* While a receipt waits for recognition, check often; otherwise rarely. */
let pollT;
function schedulePoll() {
  clearTimeout(pollT);
  if (!S.user) return;
  const waiting = S.receipts.some(r => r.status === "pending");
  pollT = setTimeout(async () => {
    if (document.visibilityState === "visible" && !S.busy && !S.sheet) await refresh(true);
    schedulePoll();
  }, waiting ? 10000 : 60000);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.user) refresh(false); });

const photoUrls = new Map();
async function photoUrl(path) {
  if (photoUrls.has(path)) return photoUrls.get(path);
  const p = SB.getPhoto(path).then(b => URL.createObjectURL(b)).catch(() => "");
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
/* The same day k months after iso; a day the month lacks (31 Feb) becomes its last day. */
function addMonths(iso, k) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1 + k, 1);
  const dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d, dim));
  return t.toLocaleDateString("sv-SE");
}

/* Months of the selected book from its start date up to today. With a budget, each month gets it plus what the
   previous month saved; overspending is not carried. Without a budget, budget and left stay null. */
function periods() {
  const b = curBook();
  if (!b || !isoD(b.startDate)) return [];
  const now = today(), out = [];
  let carry = 0;
  for (let k = 0; k < 1200; k++) {
    const from = addMonths(b.startDate, k), to = addMonths(b.startDate, k + 1);
    if (from > now) break;
    const rs = S.receipts.filter(r => isDone(r) && (r.date || "") >= from && (r.date || "") < to);
    const spent = r2(rs.reduce((s, r) => s + (+r.total || 0), 0));
    const budget = b.budget == null ? null : r2(b.budget + carry);
    out.push({ k, from, to, carry: r2(carry), budget, spent, left: budget == null ? null : r2(budget - spent), rs });
    carry = budget == null ? 0 : Math.max(0, budget - spent);
  }
  return out;
}

/* The month on screen: S.view is a month index, null means the current month. */
function selected(ps) {
  if (!ps.length) return null;
  const i = S.view == null ? ps.length - 1 : Math.max(0, Math.min(ps.length - 1, S.view));
  return ps[i];
}
const lastDay = p => { const d = parseD(p.to); d.setDate(d.getDate() - 1); return d.toLocaleDateString("sv-SE"); };
/* Date for a new receipt: today, or the last day of the past month being viewed. */
function defaultDate() {
  const ps = periods(), sel = selected(ps);
  return sel && sel !== ps[ps.length - 1] ? lastDay(sel) : today();
}

function stats() {
  const ps = periods();
  const cur = ps[ps.length - 1] || null;
  const sel = selected(ps);
  const start = curBook()?.startDate;
  const rs = S.scope === "all" || !sel
    ? S.receipts.filter(r => isDone(r) && (!start || (r.date || "") >= start))
    : sel.rs;
  const cat = new Map(), typ = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const r of rs) {
    const total = +r.total || 0;
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
  return { ps, cur, sel, isCurrent: sel === cur, cat: sorted(cat), typ: types };
}

/* ---------- render ---------- */
function render() {
  const signedIn = !!S.user;
  $("login").hidden = signedIn;
  $("app").hidden = !signedIn;
  $("fab").hidden = !signedIn;
  if (!signedIn) return;
  const st = stats();
  renderMe();
  renderBooks();
  renderBudget(st);
  $("byCat").innerHTML = bars(st.cat);
  $("byType").innerHTML = bars(st.typ);
  renderList();
  document.querySelectorAll("[data-scope]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.scope === S.scope)));
  const ok = S.state === "ready" && !S.busy && !!curBook();
  for (const id of ["camBtn", "galBtn", "manualBtn", "fab"]) $(id).disabled = !ok;
  schedulePoll();
}

function avatar(p, cls = "ava") {
  const name = p?.name || p?.email || "?";
  return p?.avatar
    ? `<img class="${cls}" src="${esc(p.avatar)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="${cls} ava-letter" aria-hidden="true">${esc(name[0].toUpperCase())}</span>`;
}

function renderMe() {
  const m = S.user.user_metadata || {};
  $("meBtn").innerHTML = `${avatar({ name: m.full_name || S.user.email, avatar: m.avatar_url })}<span>${esc((m.full_name || S.user.email || "").split(" ")[0])}</span>`;
}

function renderBooks() {
  $("books").innerHTML = S.books.map(b =>
    `<button type="button" data-act="book" data-id="${b.id}" aria-pressed="${b.id === S.bookId}">${esc(b.name)}${b.members.length > 1 ? `<span class="cnt">${b.members.length}</span>` : ""}</button>`).join("")
    + `<button type="button" class="add" data-act="new-book">+ Сборка</button>`;
}

function renderBudget(st) {
  const el = $("budgetCard"), b = curBook();
  if (S.state === "loading") { el.innerHTML = `<div class="slip-head"><span class="eyebrow">Сборка</span></div><p class="muted">Загружаю данные…</p>`; return; }
  if (S.state === "error") {
    el.innerHTML = `<div class="slip-head"><span class="eyebrow">Сборка</span></div><p class="hint">Данные не загрузились.</p>
      <div class="row"><button class="btn small" type="button" data-act="reload">Повторить</button></div>`;
    return;
  }
  if (!b) {
    el.innerHTML = `<div class="slip-head"><span class="eyebrow">Начало</span></div>
      <p class="hint">Создайте сборку чеков, например «Еда» или «Ремонт». Можно задать бюджет на месяц, а потом пригласить близких по ссылке, чтобы вести расходы вместе.</p>
      <div><button class="btn primary" type="button" data-act="new-book">Создать сборку</button></div>`;
    return;
  }
  const c = st.sel;
  const settingsLink = `<button class="link" data-act="book-settings" type="button">Настройки сборки</button>`;
  if (!c) {
    el.innerHTML = `<div class="slip-head"><span class="eyebrow">${esc(b.name)}</span>${settingsLink}</div>
      <p class="hint">Учёт начнётся ${fmtD(b.startDate)}.${b.budget ? ` Бюджет на месяц: ${money(b.budget)}.` : ""}</p>`;
    return;
  }
  const live = st.isCurrent;
  const daysIn = live ? Math.round((parseD(today()) - parseD(c.from)) / 864e5) + 1 : Math.round((parseD(c.to) - parseD(c.from)) / 864e5);
  const avg = c.spent / Math.max(1, daysIn);
  const past = st.ps.slice(0, -1).reverse();
  const head = `
    <div class="slip-head">
      <span class="mnav">
        <button class="navbtn" type="button" data-act="month-prev" aria-label="Предыдущий месяц" ${c.k === 0 ? "disabled" : ""}>‹</button>
        <span class="eyebrow">Месяц ${c.k + 1}</span>
        <button class="navbtn" type="button" data-act="month-next" aria-label="Следующий месяц" ${live ? "disabled" : ""}>›</button>
      </span>
      ${settingsLink}
    </div>
    <p class="period">${periodLabel(c)}${live ? "" : ' <span class="tag">прошлый</span>'}</p>`;
  const back = live ? "" : `<p class="hint">Новые чеки сейчас добавляются в этот месяц.</p>
    <div><button class="btn small" type="button" data-act="month-now">К текущему месяцу</button></div>`;
  const who = whoSpent(c);

  if (c.budget == null) {
    el.innerHTML = `${head}
      <div class="left plain"><span>Потрачено за месяц</span><strong>${money(c.spent)}</strong></div>
      ${who}
      <div class="rule"></div>
      <dl class="lines">
        <div><dt>В среднем тратили в день</dt><dd>${money(avg)}</dd></div>
        <div><dt>Чеков за месяц</dt><dd>${c.rs.length}</dd></div>
      </dl>
      ${back}
      ${past.length ? `<div class="rule"></div>
      <span class="eyebrow">Прошлые месяцы</span>
      <div class="months">${past.map(p => `<button type="button" class="mrow ${p === c ? "on" : ""}" data-act="month-go" data-k="${p.k}">
        <span>${periodLabel(p)}</span><span>${money(p.spent)}</span></button>`).join("")}</div>` : ""}`;
    return;
  }

  const pct = c.budget > 0 ? c.spent / c.budget * 100 : 100;
  const daysLeft = Math.max(1, Math.round((parseD(c.to) - parseD(today())) / 864e5));
  const perDay = c.left > 0 ? c.left / daysLeft : 0;
  const cap = live
    ? (c.left < 0 ? "следующий месяц начнётся снова с " + money(b.budget) : "остаток перейдёт на следующий месяц")
    : (c.left > 0 ? `месяц закрыт, ${money(c.left)} перешло на следующий` : c.left < 0 ? "месяц закрыт, перерасход не переносится" : "месяц закрыт");
  el.innerHTML = `${head}
    <dl class="lines">
      <div><dt>Бюджет на месяц</dt><dd>${money(b.budget)}</dd></div>
      ${c.carry > 0 ? `<div><dt>Перенос с прошлого</dt><dd class="pos">${signed(c.carry)}</dd></div>
      <div><dt>Итого на месяц</dt><dd>${money(c.budget)}</dd></div>` : ""}
      <div><dt>Потрачено</dt><dd>${money(c.spent)}</dd></div>
    </dl>
    <div class="rule"></div>
    <div class="left ${c.left < 0 ? "over" : ""}"><span>${c.left < 0 ? "Перерасход" : live ? "Остаток" : "Сэкономлено"}</span><strong>${money(Math.abs(c.left))}</strong></div>
    <div class="meter ${c.left < 0 ? "over" : ""}" role="img" aria-label="Израсходовано ${Math.round(pct)}%"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>
    <p class="meter-cap">Израсходовано ${Math.round(pct)}% · ${cap}</p>
    ${who}
    <div class="rule"></div>
    <dl class="lines">
      ${live ? `<div><dt>Дней до конца месяца</dt><dd>${daysLeft}</dd></div>
      <div><dt>Можно тратить в день</dt><dd>${money(perDay)}</dd></div>` : ""}
      <div><dt>В среднем тратили в день</dt><dd>${money(avg)}</dd></div>
      <div><dt>Чеков за месяц</dt><dd>${c.rs.length}</dd></div>
    </dl>
    ${back}
    ${past.length ? `<div class="rule"></div>
    <span class="eyebrow">Прошлые месяцы</span>
    <div class="months">${past.map(p => `<button type="button" class="mrow ${p === c ? "on" : ""}" data-act="month-go" data-k="${p.k}">
      <span>${periodLabel(p)}</span><span class="${p.left < 0 ? "neg" : "pos"}">${signed(p.left)}</span></button>`).join("")}</div>` : ""}`;
}

/* «Кто сколько потратил» for a shared book. */
function whoSpent(p) {
  const b = curBook();
  if (!b || b.members.length < 2) return "";
  const sums = new Map(b.members.map(m => [m.userId, 0]));
  for (const r of p.rs) sums.set(r.author, (sums.get(r.author) || 0) + (+r.total || 0));
  const rows = [...sums].filter(([id, v]) => v > 0 || person(id)).sort((a, c) => c[1] - a[1]);
  return `<div class="rule"></div><span class="eyebrow">Кто сколько потратил</span>
    <dl class="lines">${rows.map(([id, v]) => `<div><dt>${esc(personName(id))}</dt><dd>${money(v)}</dd></div>`).join("")}</dl>`;
}

function periodLabel(p) {
  const end = parseD(p.to); end.setDate(end.getDate() - 1);
  const f = d => d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  return `${f(parseD(p.from))} – ${f(end)}`;
}
const signed = v => (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v));

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
  const sel = selected(periods());
  const byMonth = S.scope !== "all" && sel;
  const all = receipts();
  const shared = (curBook()?.members.length || 0) > 1;
  /* Receipts still waiting or failed are shown in every month so they are not lost from sight. */
  const list = byMonth ? all.filter(r => !isDone(r) || ((r.date || "") >= sel.from && (r.date || "") < sel.to)) : all;
  const waiting = list.filter(r => r.status === "pending").length;
  $("rcount").textContent = curBook() ? (byMonth ? periodLabel(sel) + " · " : "") + `${list.length} шт.${waiting ? ` · ждут распознавания: ${waiting}` : ""}` : "";
  if (S.state !== "ready") { el.innerHTML = `<p class="empty">${S.state === "error" ? "Чеки не загрузились." : "Загружаю чеки…"}</p>`; return; }
  if (!curBook()) { el.innerHTML = `<p class="empty">Чеки появятся, когда вы создадите сборку.</p>`; return; }
  if (all.length && !list.length) {
    el.innerHTML = `<p class="empty">В этом месяце чеков нет. Добавьте чек: он попадёт в этот месяц.</p>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <strong>Пока нет ни одного чека</strong>
      <span>Нажмите «Сфотографировать чек»: магазин, дата, позиции и итог распознаются сами, а покупки разложатся по видам затрат и продуктов. Или нажмите «Ввести вручную», отметьте, что купили, и впишите суммы.</span>
    </div>`;
    return;
  }
  const start = curBook()?.startDate;
  el.innerHTML = list.map(r => {
    const open = S.open === r.id;
    const before = isDone(r) && start && (r.date || "") < start;
    const tag = r.status === "pending" ? '<span class="tag wait">ждёт распознавания</span>'
      : r.status === "error" ? '<span class="tag err">не распознан</span>'
      : before ? '<span class="tag">до старта</span>' : "";
    const kinds = [...new Set((r.items || []).map(i => i.type || i.name).filter(Boolean))];
    const title = !isDone(r) ? "Новый чек"
      : r.store || (kinds.length ? kinds.slice(0, 3).join(", ") + (kinds.length > 3 ? "…" : "") : "Без названия");
    return `<article class="rc">
      <button class="rc-row" type="button" data-act="toggle" data-id="${esc(r.id)}" aria-expanded="${open}">
        <span class="rc-date">${fmtD(r.date)}</span>
        <span class="rc-store">${esc(title)}${tag}${shared ? `<span class="by">${esc(firstName(r.author))}</span>` : ""}</span>
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
  const editable = canEdit(r);
  const photos = (r.photos || []).length ? `<div class="photos">${r.photos.map(p => `<img data-photo="${esc(p)}" data-act="zoom" alt="Фото чека">`).join("")}</div>` : "";
  const delBtns = editable ? `
      <button class="btn small danger ${sure ? "sure" : ""}" type="button" data-act="${sure ? "del-yes" : "del"}" data-id="${esc(r.id)}">${sure ? "Да, удалить чек" : "Удалить"}</button>
      ${sure ? `<button class="btn small ghost" type="button" data-act="del-no">Отмена</button>` : ""}` : "";
  const author = (curBook()?.members.length || 0) > 1 ? `<p class="hint">Добавил${r.author === myId() ? "и вы" : ": " + esc(personName(r.author))}</p>` : "";
  const move = editable && S.books.length > 1 ? `<div class="moveto"><span class="hint">Сборка:</span>${S.books.map(b =>
    `<button type="button" class="chip small" data-act="move" data-id="${esc(r.id)}" data-book="${b.id}" aria-pressed="${r.bookId === b.id}">${esc(b.name)}</button>`).join("")}</div>` : "";
  const readonly = editable ? "" : `<p class="hint">Менять этот чек может его автор или владелец сборки.</p>`;
  if (r.status === "pending" || r.status === "error") {
    return `<div class="rc-detail">
      ${photos}${author}${move}
      <p class="hint">${r.status === "pending"
        ? "Чек скоро распознается. Можно не ждать и заполнить его вручную."
        : "Чек не удалось прочитать: " + esc(r.error || "причина неизвестна") + ". Попробуйте ещё раз или заполните вручную."}</p>
      ${editable ? `<div class="row">
        ${r.status === "error" ? `<button class="btn small" type="button" data-act="retry" data-id="${esc(r.id)}">Распознать ещё раз</button>` : ""}
        <button class="btn small" type="button" data-act="edit" data-id="${esc(r.id)}">Заполнить вручную</button>
        ${delBtns}
      </div>` : readonly}
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
        ${items.length > 1 || Math.abs(diff) >= 0.01 ? `<tr><td colspan="3"><strong>Итого</strong></td><td class="num"><strong>${money(r.total)}</strong></td></tr>` : ""}
      </tbody>
    </table></div>
    ${author}${move}
    ${editable ? `<div class="row">
      <button class="btn small" type="button" data-act="edit" data-id="${esc(r.id)}">Изменить</button>
      ${delBtns}
    </div>` : readonly}
  </div>`;
}

/* ---------- sheets: receipt editor, book settings, new book, account ---------- */
function openSheet(kind) {
  S.sheet = kind;
  $("sheetWrap").hidden = false;
  document.body.classList.add("lock");
  ({ account: renderAccount, book: renderBookSheet, "new-book": renderNewBook }[kind] || renderSheet)();
}
function openDraft(d) { S.draft = d; openSheet("receipt"); }
function closeSheet() {
  S.draft = null; S.sheet = null; S.invite = null; S.confirmBook = null;
  $("sheetWrap").hidden = true;
  document.body.classList.remove("lock");
}

function bookFields(b) {
  return `
    <label for="bName">Название<input id="bName" maxlength="60" required value="${esc(b?.name || "")}" placeholder="Например, Еда" autocomplete="off"></label>
    <label for="bBudget">Бюджет на месяц, ₴ (необязательно)<input id="bBudget" inputmode="decimal" value="${b?.budget ? esc(toIn(b.budget)) : ""}" placeholder="Без лимита"></label>
    <p class="hint">С бюджетом видно остаток, а сэкономленное переходит на следующий месяц. Без бюджета просто считаются расходы.</p>
    <label for="bStart" class="date-only">Начало первого месяца<input type="date" id="bStart" required value="${esc(b?.startDate || today())}"></label>`;
}

function renderNewBook() {
  $("sheet").innerHTML = `
    <header class="sh-head"><h2>Новая сборка</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    <form id="newBookForm" class="bform">
      ${bookFields(null)}
      <p class="hint">Потом в настройках сборки можно пригласить людей по ссылке.</p>
      <div class="row end">
        <button class="btn ghost" type="button" data-act="close">Отмена</button>
        <button class="btn primary" type="submit">Создать</button>
      </div>
    </form>`;
  $("bName").focus();
}

function renderBookSheet() {
  const b = curBook(); if (!b) return closeSheet();
  const owner = isOwner(b);
  const link = S.invite ? `${location.origin}${location.pathname}?join=${S.invite}` : "";
  $("sheet").innerHTML = `
    <header class="sh-head"><h2>${esc(b.name)}</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    ${owner ? `<form id="bookForm" class="bform">
      ${bookFields(b)}
      <div class="row"><button class="btn primary" type="submit">Сохранить</button></div>
    </form>` : `<dl class="lines">
      <div><dt>Бюджет на месяц</dt><dd>${b.budget ? money(b.budget) : "без лимита"}</dd></div>
      <div><dt>Начало учёта</dt><dd>${fmtD(b.startDate)}</dd></div>
    </dl><p class="hint">Настройки меняет владелец сборки.</p>`}
    <div class="rule"></div>
    <h3>Участники</h3>
    <ul class="people">${b.members.map(m => `<li>
      ${avatar(m)}
      <span class="pname">${esc(m.name || m.email || "Участник")}${m.userId === myId() ? " (вы)" : ""}<small>${m.role === "owner" ? "владелец" : "участник"}${m.email ? " · " + esc(m.email) : ""}</small></span>
      ${owner && m.userId !== myId() ? `<button class="btn small ghost danger" type="button" data-act="kick" data-user="${m.userId}">Убрать</button>` : ""}
    </li>`).join("")}</ul>
    <div class="invite">
      <h3>Пригласить</h3>
      <p class="hint">Отправьте ссылку человеку. Он войдёт через Google и попадёт в эту сборку: будет видеть её чеки и добавлять свои.</p>
      ${link ? `<div class="keyrow"><input id="inviteLink" readonly value="${esc(link)}"><button class="btn small primary" type="button" data-act="copy-invite">Скопировать</button></div>`
        : `<div><button class="btn" type="button" data-act="make-invite">Получить ссылку-приглашение</button></div>`}
    </div>
    <div class="rule"></div>
    <div class="row">
      ${owner
        ? `<button class="btn small danger ${S.confirmBook ? "sure" : ""}" type="button" data-act="${S.confirmBook ? "delete-book-yes" : "delete-book"}">${S.confirmBook ? "Да, удалить сборку со всеми чеками" : "Удалить сборку"}</button>`
        : `<button class="btn small danger ${S.confirmBook ? "sure" : ""}" type="button" data-act="${S.confirmBook ? "leave-book-yes" : "leave-book"}">${S.confirmBook ? "Да, выйти из сборки" : "Выйти из сборки"}</button>`}
      ${S.confirmBook ? `<button class="btn small ghost" type="button" data-act="unconfirm-book">Отмена</button>` : ""}
    </div>`;
}

function renderAccount() {
  const m = S.user.user_metadata || {};
  $("sheet").innerHTML = `
    <header class="sh-head"><h2>Аккаунт</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    <div class="person-big">${avatar({ name: m.full_name || S.user.email, avatar: m.avatar_url }, "ava big")}
      <span class="pname">${esc(m.full_name || "")}<small>${esc(S.user.email || "")}</small></span></div>
    <p class="hint">Сборок: ${S.books.length}. Вы видите только свои сборки и те, куда вас пригласили.</p>
    <div class="row"><button class="btn danger" type="button" data-act="sign-out">Выйти из аккаунта</button></div>`;
}

/* ---------- quick manual entry: pick what was bought, type how much ---------- */
const OTHER = EXP.filter(c => c !== "Продукты" && c !== "Другое" && c !== PERSONAL);

/* Choices: food types, other expense kinds, kinds already used in this book, and personal kinds typed in
   through «Другое» (category «Личные»), which are remembered because they live in the saved receipts. */
function pickGroups() {
  const food = [...FOOD], other = OTHER.map(c => ({ type: c, category: c })), personal = [];
  const known = new Set([...FOOD, ...OTHER, "Другое"]);
  const used = [...S.receipts.flatMap(r => r.items || []), ...(S.draft?.picks || [])];
  for (const it of used) {
    const t = String(it.type || "").trim();
    if (!t || known.has(t)) continue;
    known.add(t);
    if (it.category === PERSONAL) personal.push(t);
    else if (it.category === "Продукты") food.push(t);
    else other.push({ type: t, category: EXP.includes(it.category) ? it.category : "Другое" });
  }
  return { food, other, personal: personal.sort((a, b) => a.localeCompare(b, "ru")) };
}

/* Hide personal kinds that do not match what is typed in the «Другое» field. */
function filterPersonal() {
  const q = (S.draft?.otherText || "").trim().toLowerCase();
  const chips = [...document.querySelectorAll("#personalGroup .chip")];
  chips.forEach(c => { c.hidden = !!q && !c.dataset.type.toLowerCase().includes(q); });
  const none = $("personalNone");
  if (none) none.hidden = !q || chips.some(c => !c.hidden);
}

function addPersonal() {
  const d = S.draft;
  let name = (d.otherText || "").trim().replace(/\s+/g, " ");
  if (!name) { d.msg = "Впишите, что это, например «Подарок»."; renderSimple(); $("otherIn")?.focus(); return; }
  name = name[0].toUpperCase() + name.slice(1);
  const same = pickGroups().personal.find(t => t.toLowerCase() === name.toLowerCase());
  if (same) name = same;
  let i = d.picks.findIndex(p => p.type.toLowerCase() === name.toLowerCase());
  if (i < 0) { d.picks.push({ type: name, category: PERSONAL, price: "" }); i = d.picks.length - 1; }
  d.otherText = ""; d.otherOpen = false; d.msg = "";
  renderSimple();
  document.querySelector(`[data-p="${i}"]`)?.focus();
}

function simpleDraft(base, items) {
  return {
    ...base, simple: true,
    picks: (items || []).map(i => ({
      type: i.type || i.name, category: i.category, price: toIn(i.price),
      note: i.name && i.name !== (i.type || i.name) ? i.name : ""
    }))
  };
}

function renderSimple() {
  const d = S.draft, el = $("sheet");
  const chosen = new Set(d.picks.map(p => p.type));
  const g = pickGroups();
  const chip = (type, cat) => `<button type="button" class="chip" data-act="pick" data-type="${esc(type)}" data-cat="${esc(cat)}" aria-pressed="${chosen.has(type)}">${esc(type)}</button>`;
  const thumbs = (d.photos || []).map(p => `<img data-photo="${esc(p)}" alt="Фото чека">`).join("");
  el.innerHTML = `
    <header class="sh-head"><h2>${d.isNew ? "Новый чек" : "Чек"}</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    ${d.msg ? `<p class="notice">${esc(d.msg)}</p>` : ""}
    ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}
    <label for="dDate" class="date-only">Дата покупки<input type="date" id="dDate" value="${esc(d.date)}"></label>
    <div class="picker">
      <div class="pgroup"><span class="eyebrow">Продукты</span><div class="chips">${g.food.map(t => chip(t, "Продукты")).join("")}</div></div>
      <div class="pgroup"><span class="eyebrow">Остальное</span><div class="chips">${g.other.map(o => chip(o.type, o.category)).join("")}
        <button type="button" class="chip" data-act="other-toggle" aria-expanded="${!!d.otherOpen}" aria-pressed="${!!d.otherOpen}">Другое…</button></div></div>
      ${d.otherOpen ? `<div class="otherbox">
        <div class="keyrow">
          <input id="otherIn" value="${esc(d.otherText || "")}" placeholder="Что это? Например: подарок, стрижка" autocomplete="off" aria-label="Название личной траты">
          <button class="btn small primary" type="button" data-act="other-add">Добавить</button>
        </div>
        <p class="hint">Попадёт в «Личные» и запомнится для следующих чеков.${g.personal.length ? " Пока пишете, ниже остаются только подходящие." : ""}</p>
      </div>` : ""}
      ${g.personal.length ? `<div class="pgroup" id="personalGroup"><span class="eyebrow">Личные</span>
        <div class="chips">${g.personal.map(t => chip(t, PERSONAL)).join("")}</div>
        <p class="hint" id="personalNone" hidden>Такого ещё нет. Нажмите «Добавить», и оно запомнится.</p></div>` : ""}
    </div>
    <div class="picks">
      <span class="eyebrow">Сколько потратили</span>
      ${d.picks.length ? d.picks.map((p, i) => `<div class="prow">
        <span class="p-type">${esc(p.type)}</span>
        <input class="p-note" data-n="${i}" value="${esc(p.note || "")}" placeholder="Что именно купили (необязательно)" autocomplete="off" aria-label="Что именно купили: ${esc(p.type)}">
        <input class="i-price" data-p="${i}" inputmode="decimal" value="${esc(p.price)}" placeholder="0,00" aria-label="Сумма: ${esc(p.type)}">
        <button class="i-del" type="button" data-act="unpick" data-i="${i}" aria-label="Убрать: ${esc(p.type)}">×</button>
      </div>`).join("") : '<p class="hint">Отметьте выше, что купили. Можно выбрать несколько.</p>'}
    </div>
    <div class="totals"><div><span>Итого по чеку</span><strong class="num" id="pSum"></strong></div></div>
    <div class="row end">
      <button class="btn ghost" type="button" data-act="close">Отмена</button>
      <button class="btn primary" type="button" data-act="save" id="saveBtn">Сохранить чек</button>
    </div>`;
  fillPhotos(el);
  updatePickSum();
  filterPersonal();
}

function updatePickSum() {
  const d = S.draft;
  if (d?.simple && $("pSum")) $("pSum").textContent = money(d.picks.reduce((s, p) => s + num(p.price), 0));
}

async function storeReceipt(d, rec, retry) {
  try {
    putLocal(await SB.upsertReceipt(rec));
    S.open = rec.id;
    closeSheet();
    render();
    toast("Чек сохранён");
  } catch (e) {
    d.msg = errText(e);
    retry();
  }
}

async function saveSimple() {
  const d = S.draft;
  const items = d.picks.filter(p => num(p.price))
    .map(p => ({ name: String(p.note || "").trim() || p.type, price: r2(num(p.price)), category: EXP.includes(p.category) ? p.category : "Другое", type: p.type }));
  if (!items.length) { d.msg = "Отметьте, что купили, и впишите сумму."; renderSimple(); return; }
  const btn = $("saveBtn"); btn.disabled = true; btn.textContent = "Сохраняю…";
  await storeReceipt(d, {
    id: d.id, bookId: d.bookId || S.bookId, status: "done", manual: true, store: "", date: isoD(d.date) ? d.date : today(),
    total: r2(items.reduce((s, i) => s + i.price, 0)), items, photos: d.photos || []
  }, renderSimple);
}

function renderSheet() {
  const d = S.draft, el = $("sheet");
  if (!d) return;
  if (d.simple) { renderSimple(); return; }
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
  if (!list.length || S.state !== "ready" || !curBook()) return;
  if (list.length > MAX_IMAGES) toast(`Взяты первые ${MAX_IMAGES} фото`);
  S.busy = true; render();
  notice("Отправляю фото чека…");
  const id = uid(), paths = [], pendingDate = defaultDate(), book = curBook();
  try {
    const files = await Promise.all(list.slice(0, MAX_IMAGES).map(shrink));
    for (let i = 0; i < files.length; i++) {
      const path = `${myId()}/${id}-${i + 1}.jpg`;
      await SB.putPhoto(path, files[i]);
      paths.push(path);
    }
    putLocal(await SB.upsertReceipt({ id, bookId: book.id, status: "pending", date: pendingDate, store: "", total: 0, items: [], photos: paths }));
    S.open = id;
    notice("");
    toast((pendingDate === today() ? "Чек в очереди на распознавание" : `Чек в очереди, дата ${fmtD(pendingDate)}. Если на чеке другая дата, она подставится сама`)
      + ` · ${book.name}`);
  } catch (err) {
    SB.deletePhotos(paths).catch(() => {});
    notice(errText(err));
  }
  S.busy = false; render();
}

async function saveDraft() {
  const d = S.draft; if (!d) return;
  if (d.simple) return saveSimple();
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
  await storeReceipt(d, {
    id: d.id, bookId: d.bookId || S.bookId, status: "done", store: String(d.store || "").trim(), date: isoD(d.date) ? d.date : today(),
    total, items, photos: d.photos || []
  }, renderSheet);
}

function readBookForm() {
  const name = $("bName").value.trim();
  const raw = $("bBudget").value.trim();
  const budget = raw ? r2(num(raw)) : null;
  const startDate = $("bStart").value;
  if (!name) return { error: "Впишите название сборки." };
  if (raw && !(budget > 0)) return { error: "Бюджет должен быть больше нуля, или оставьте поле пустым." };
  if (!isoD(startDate)) return { error: "Укажите дату начала." };
  return { name, budget, startDate };
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  const d = S.draft;
  switch (act) {
    case "reload": S.state = "loading"; render(); refresh(false); break;
    case "book": selectBook(id); break;
    case "new-book": openSheet("new-book"); break;
    case "book-settings": S.invite = null; S.confirmBook = null; openSheet("book"); break;
    case "month-prev": case "month-next": case "month-go": case "month-now": {
      const ps = periods(), sel = selected(ps);
      if (!sel) break;
      let k = act === "month-prev" ? sel.k - 1 : act === "month-next" ? sel.k + 1 : act === "month-go" ? +t.dataset.k : ps.length - 1;
      k = Math.max(0, Math.min(ps.length - 1, k));
      S.view = k === ps.length - 1 ? null : k;
      S.open = null; S.confirmDel = null;
      render();
      break;
    }
    case "scope": S.scope = t.dataset.scope === "all" ? "all" : "month"; lsSet("scope", S.scope); render(); break;
    case "move": {
      const target = S.books.find(b => b.id === t.dataset.book);
      const r = S.receipts.find(x => x.id === id);
      if (!target || !r || r.bookId === target.id) break;
      try {
        putLocal(await SB.patchReceipt(id, { bookId: target.id }));
        S.open = null; render();
        toast(`Чек перенесён в «${target.name}»`);
      } catch (err) { toast(errText(err)); }
      break;
    }
    case "toggle": S.open = S.open === id ? null : id; S.confirmDel = null; renderList(); break;
    case "edit": {
      const r = S.receipts.find(x => x.id === id); if (!r) return;
      /* Typed-in receipts and ones not yet recognized use the quick form; recognized ones keep the full editor. */
      if (r.manual || !isDone(r)) {
        openDraft(simpleDraft({ id: r.id, bookId: r.bookId, date: r.date || defaultDate(), photos: [...(r.photos || [])], isNew: !isDone(r) }, r.items));
        break;
      }
      const items = (r.items || []).map(i => ({ name: i.name, price: toIn(i.price), category: i.category, type: i.type || "" }));
      openDraft({
        id: r.id, bookId: r.bookId, store: r.store || "", date: r.date || today(), total: toIn(r.total),
        items: items.length ? items : [blankItem()], photos: [...(r.photos || [])], isNew: false
      });
      break;
    }
    case "retry":
      try {
        putLocal(await SB.patchReceipt(id, { status: "pending", error: null }));
        render();
        toast("Чек снова в очереди");
      } catch (err) { toast(errText(err)); }
      break;
    case "del": S.confirmDel = id; renderList(); break;
    case "del-no": S.confirmDel = null; renderList(); break;
    case "del-yes": {
      const r = S.receipts.find(x => x.id === id); if (!r) return;
      t.disabled = true;
      try {
        await SB.deleteReceipt(id);
        S.receipts = S.receipts.filter(x => x.id !== id);
        S.confirmDel = null; S.open = null; render();
        toast("Чек удалён");
        SB.deletePhotos(r.photos || []).catch(() => {});
      } catch (err) { toast(errText(err)); t.disabled = false; }
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
    case "make-invite":
      t.disabled = true;
      try { S.invite = await SB.inviteToken(S.bookId); renderBookSheet(); $("inviteLink")?.select(); }
      catch (err) { toast(errText(err)); t.disabled = false; }
      break;
    case "copy-invite": {
      const inp = $("inviteLink");
      try { await navigator.clipboard.writeText(inp.value); toast("Ссылка скопирована. Отправьте её человеку"); }
      catch { inp.select(); toast("Выделил ссылку, скопируйте её вручную"); }
      break;
    }
    case "kick": {
      const m = person(t.dataset.user);
      try {
        await SB.removeMember(S.bookId, t.dataset.user);
        await loadBooks(); renderBookSheet(); render();
        toast(`${m?.name || "Участник"} больше не в сборке`);
      } catch (err) { toast(errText(err)); }
      break;
    }
    case "delete-book": case "leave-book": S.confirmBook = true; renderBookSheet(); break;
    case "unconfirm-book": S.confirmBook = null; renderBookSheet(); break;
    case "delete-book-yes": case "leave-book-yes": {
      const b = curBook();
      try {
        if (act === "delete-book-yes") await SB.deleteBook(b.id);
        else await SB.removeMember(b.id, myId());
        closeSheet();
        S.bookId = null; S.receipts = [];
        await refresh(false);
        toast(act === "delete-book-yes" ? `Сборка «${b.name}» удалена` : `Вы вышли из «${b.name}»`);
      } catch (err) { toast(errText(err)); }
      break;
    }
    case "sign-out": await SB.signOut(); closeSheet(); break;
    case "close": closeSheet(); break;
    case "pick": if (d?.simple) {
      const type = t.dataset.type, i = d.picks.findIndex(p => p.type === type);
      if (i >= 0) d.picks.splice(i, 1); else d.picks.push({ type, category: t.dataset.cat, price: "" });
      renderSimple();
      if (i < 0) document.querySelector(`[data-p="${d.picks.length - 1}"]`)?.focus();
    } break;
    case "other-toggle": if (d?.simple) {
      d.otherOpen = !d.otherOpen; d.msg = "";
      renderSimple();
      if (d.otherOpen) $("otherIn")?.focus();
    } break;
    case "other-add": if (d?.simple) addPersonal(); break;
    case "unpick": if (d?.simple) { d.picks.splice(+t.dataset.i, 1); renderSimple(); } break;
    case "add-row": if (d) { d.items.push(blankItem()); renderSheet(); $("irows").lastElementChild?.querySelector("input")?.focus(); } break;
    case "del-row": if (d) { d.items.splice(+t.dataset.i, 1); if (!d.items.length) d.items.push(blankItem()); renderSheet(); } break;
    case "save": saveDraft(); break;
  }
});

$("sheet").addEventListener("input", e => {
  const d = S.draft; if (!d || S.sheet !== "receipt") return;
  const t = e.target;
  if (t.dataset.p != null) { d.picks[+t.dataset.p].price = t.value; updatePickSum(); return; }
  if (t.dataset.n != null) { d.picks[+t.dataset.n].note = t.value; return; }
  if (t.id === "otherIn") { d.otherText = t.value; filterPersonal(); return; }
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
  if (e.key === "Enter" && e.target.id === "otherIn") { e.preventDefault(); addPersonal(); return; }
  if (e.key !== "Escape") return;
  const v = document.querySelector(".viewer"); if (v) { v.remove(); return; }
  if (S.sheet) closeSheet();
});

document.addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.id !== "newBookForm" && e.target.id !== "bookForm") return;
  const f = readBookForm();
  if (f.error) { toast(f.error); return; }
  const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
  try {
    if (e.target.id === "newBookForm") {
      const row = await SB.createBook(f);
      closeSheet();
      await loadBooks();
      selectBook(row.id);
      toast(`Сборка «${f.name}» создана`);
    } else {
      await SB.updateBook(S.bookId, f);
      await loadBooks();
      S.view = null;
      closeSheet(); render();
      toast("Настройки сохранены");
    }
  } catch (err) { toast(errText(err)); btn.disabled = false; }
});

$("camBtn").onclick = $("fab").onclick = () => $("camIn").click();
$("galBtn").onclick = () => $("galIn").click();
$("camIn").onchange = onFiles;
$("galIn").onchange = onFiles;
$("manualBtn").onclick = () => openDraft(simpleDraft({ id: uid(), bookId: S.bookId, date: defaultDate(), photos: [], isNew: true }, []));
$("meBtn").onclick = () => openSheet("account");
$("googleBtn").onclick = async () => {
  $("googleBtn").disabled = true;
  const { error } = await SB.signIn();
  if (error) { $("loginMsg").textContent = errText(error); $("googleBtn").disabled = false; }
};

/* ---------- boot: invite link, session, data ---------- */
(() => {
  const join = new URLSearchParams(location.search).get("join");
  if (join) {
    lsSet("pendingJoin", join);
    history.replaceState(null, "", location.pathname + location.hash);
  }
  $("joinNote").hidden = !lsGet("pendingJoin", "");
})();

async function onSession(session) {
  const was = S.user?.id;
  S.user = session?.user || null;
  if (!S.user) { S.books = []; S.receipts = []; S.bookId = null; S.state = "auth"; render(); return; }
  if (was === S.user.id && (S.state === "ready" || S.state === "loading")) return;
  S.state = "loading"; render();
  const join = lsGet("pendingJoin", "");
  if (join) {
    lsDel("pendingJoin");
    try {
      const b = await SB.join(join);
      if (b) { S.bookId = b.book_id; lsSet("book", b.book_id); toast(`Вы в сборке «${b.name}»`); }
    } catch (err) { toast(errText(err)); }
  }
  await refresh(false);
}

S.scope = lsGet("scope", "month") === "all" ? "all" : "month";
SB.onAuth(onSession);
SB.session().then(onSession);
