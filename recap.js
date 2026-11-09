"use strict";
/* CHK-7: «Итоги месяца» — a 1080×1350 PNG of one book month, drawn on a canvas right in the browser and handed over
   through the system share menu (Web Share with a file) or as a download. Nothing is sent anywhere: the numbers come
   from what app.js has already loaded. The picture never shows the book name, member names, stores or items. */
/* Loaded before app.js, because app.js may render (and call renderRecapNote) as soon as it runs. So the code here
   uses app.js helpers ($, S, periods, money…) only inside functions, never at load time. */

const RECAP_LINK = "https://nikita5453.github.io/cheki/";
const RECAP_TEXT = "Мои итоги месяца в «Бюджете по чекам»: " + RECAP_LINK;

/* k: month index on screen in the sheet (null = sheet closed); token drops results of a stale build. */
const R = { k: null, hide: false, busy: false, err: false, file: null, url: "", alt: "", share: false, token: 0, opener: null, hist: false };

/* ---------- numbers ---------- */
/* The «По видам продуктов» rows of a month, built exactly as stats() builds them, so the percentages match the site. */
function recapTypes(rs) {
  const typ = new Map();
  for (const r of rs) for (const p of parts(r)) typ.set(p.typ, (typ.get(p.typ) || 0) + p.v);
  let rows = [...typ].filter(e => Math.abs(e[1]) >= 0.005).sort((a, b) => b[1] - a[1]);
  if (rows.length > 14) rows = [...rows.slice(0, 13), [REST, rows.slice(13).reduce((s, e) => s + e[1], 0)]];
  return rows;
}

/* «5 окт. – 4 нояб. 2026», or with both years when the month crosses New Year. */
function recapPeriod(p) {
  const a = parseD(p.from), b = parseD(lastDay(p));
  const f = d => d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  return a.getFullYear() === b.getFullYear() ? `${periodLabel(p)} ${b.getFullYear()}` : `${f(a)} ${a.getFullYear()} – ${f(b)} ${b.getFullYear()}`;
}

function recapData(k, hide) {
  const ps = periods(), c = ps[k];
  if (!c) return null;
  const live = c === ps[ps.length - 1], prev = ps[k - 1];
  let cmp = null;
  if (prev && prev.spent > 0) {
    const d = Math.round((c.spent - prev.spent) / prev.spent * 100);
    cmp = { pct: Math.abs(d), dir: Math.sign(d) };
  }
  /* Percent and bar length as in the breakdown: of the sum of all its rows, and of its largest row. */
  const rows = recapTypes(c.rs);
  const tot = rows.reduce((s, e) => s + e[1], 0), max = Math.max(0, ...rows.map(e => Math.abs(e[1])));
  const top = rows.filter(e => e[0] !== NO_SPLIT && e[0] !== REST && e[1] > 0).slice(0, 3)
    .map(([name, v]) => ({ name, pct: tot > 0 ? Math.round(v / tot * 100) : 0, share: max > 0 ? v / max : 0 }));
  const budget = c.budget == null ? null
    : { over: c.left < 0, amount: money(Math.abs(c.left)), used: Math.round(c.budget > 0 ? c.spent / c.budget * 100 : 100) };
  const n = c.rs.length;
  return { from: c.from, live, hide, period: recapPeriod(c), spent: money(c.spent), count: n, countText: `${n} ${receiptWord(n)}`, cmp, top, budget };
}

/* ---------- drawing (reference code from the Designer spec) ---------- */
const RC = { bg: "#E7ECE9", paper: "#FBFCFA", ink: "#17201B", muted: "#5B6960", line: "#D2DBD5", accent: "#2E44C4",
  good: "#1E7448", goodSoft: "#DDEEE3", bad: "#B8322A", badSoft: "#F6E1DE" };
const RF = { disp: '"Unbounded", "Golos Text", sans-serif', body: '"Golos Text", system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, monospace' };
const RECAP_ICON = new Path2D("M18 12h28v40l-4.7-3-4.6 3-4.7-3-4.7 3-4.6-3-4.7 3z");

/* The site fonts with their Cyrillic subsets, but no longer than 3 seconds; after that draw with what is there. */
async function loadRecapFonts() {
  const cyr = "Итоги месяца Потрачено 0123456789 ₴%…";
  const faces = ['500 30px "Unbounded"', '700 30px "Unbounded"', '400 34px "Golos Text"', '500 34px "Golos Text"', '600 34px "Golos Text"',
    '400 26px "JetBrains Mono"', '600 40px "JetBrains Mono"'];
  const all = Promise.all(faces.map(f => document.fonts.load(f, cyr))).catch(() => {});
  await Promise.race([all, new Promise(r => setTimeout(r, 3000))]);
}

function drawRecap(canvas, d) {
  const ctx = canvas.getContext("2d");
  const W = 1080, H = 1350, SX = 72, SW = 936, PAD = 72, X = SX + PAD, TW = SW - PAD * 2;
  const font = (w, s, f) => { ctx.font = `${w} ${s}px ${f}`; };
  const spacing = v => { if ("letterSpacing" in ctx) ctx.letterSpacing = v; };
  const fit = (text, max) => { if (ctx.measureText(text).width <= max) return text;
    let t = text; while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1); return t.trimEnd() + "…"; };
  /* Layout first (y grows with the content), paint later, once the slip height is known. */
  const ops = []; let y = 0;
  const at = fn => { const yy = y; ops.push(() => fn(yy)); };
  // header
  y += 78;
  at(yy => { font(500, 30, RF.disp); spacing("3px"); ctx.fillStyle = RC.muted; ctx.textAlign = "left"; ctx.fillText("ИТОГИ МЕСЯЦА", X, yy); spacing("0px");
    if (d.live) { font(500, 28, RF.body); const tw = ctx.measureText("пока что").width, w = tw + 40, x = X + TW - w;
      ctx.strokeStyle = RC.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(x, yy - 35, w, 48, 24); ctx.stroke();
      ctx.fillStyle = RC.accent; ctx.fillText("пока что", x + 20, yy - 1); } });
  y += 64;
  at(yy => { font(600, 46, RF.body); ctx.fillStyle = RC.ink; ctx.fillText(fit(d.period, TW), X, yy); });
  // main figure
  y += 76;
  at(yy => { font(400, 34, RF.body); ctx.fillStyle = RC.muted; ctx.fillText(d.hide ? "Чеков за месяц" : "Потрачено", X, yy); });
  y += 108;
  at(yy => { const big = d.hide ? String(d.count) : d.spent; let s = 116; font(600, s, RF.mono);
    while (s > 72 && ctx.measureText(big).width > TW) { s -= 2; font(600, s, RF.mono); }
    ctx.fillStyle = RC.ink; ctx.fillText(big, X, yy); });
  if (!d.hide) { y += 54; at(yy => { font(400, 36, RF.body); ctx.fillStyle = RC.muted; ctx.fillText(d.countText, X, yy); }); }
  else y += 8;
  // comparison
  if (d.cmp) {
    y += 32;
    at(yy => {
      const p = d.live ? "пока " : "";
      const t = d.cmp.dir === 0 ? (d.live ? "пока столько же, сколько за весь прошлый месяц" : "столько же, сколько в прошлом месяце")
        : `${p}на ${d.cmp.pct}% ${d.cmp.dir < 0 ? "меньше" : "больше"}, ${d.live ? "чем за весь прошлый месяц" : "чем в прошлом месяце"}`;
      const fg = d.cmp.dir < 0 ? RC.good : d.cmp.dir > 0 ? RC.bad : RC.muted, bg = d.cmp.dir < 0 ? RC.goodSoft : d.cmp.dir > 0 ? RC.badSoft : RC.bg;
      let s = 32; font(500, s, RF.body); while (s > 24 && ctx.measureText(t).width + 56 > TW) { s -= 1; font(500, s, RF.body); }
      const w = ctx.measureText(t).width + 56;
      ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(X, yy, w, 64, 32); ctx.fill();
      ctx.fillStyle = fg; ctx.fillText(t, X + 28, yy + 43);
    });
    y += 64;
  }
  const rule = () => { at(yy => { ctx.strokeStyle = RC.line; ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.moveTo(X, yy); ctx.lineTo(X + TW, yy); ctx.stroke(); ctx.setLineDash([]); }); };
  // top 3
  if (d.top && d.top.length) {
    y += 48; rule();
    y += 58; at(yy => { font(500, 26, RF.disp); spacing("2px"); ctx.fillStyle = RC.muted; ctx.fillText("БОЛЬШЕ ВСЕГО УШЛО НА", X, yy); spacing("0px"); });
    d.top.slice(0, 3).forEach((r, i) => {
      y += i === 0 ? 74 : 96;
      at(yy => {
        font(600, 40, RF.mono); ctx.fillStyle = RC.ink; ctx.textAlign = "right"; ctx.fillText(r.pct + "%", X + TW, yy); ctx.textAlign = "left";
        font(500, 40, RF.body); ctx.fillText(fit(r.name, TW - 150), X, yy);
        ctx.fillStyle = RC.bg; ctx.beginPath(); ctx.roundRect(X, yy + 22, TW, 14, 7); ctx.fill();
        ctx.fillStyle = RC.accent; ctx.beginPath(); ctx.roundRect(X, yy + 22, Math.max(14, TW * Math.min(1, r.share)), 14, 7); ctx.fill();
      });
    });
    y += 36;
  }
  // budget
  if (d.budget) {
    y += 48; rule();
    y += 60;
    at(yy => { font(600, 38, RF.body); ctx.fillStyle = d.budget.over ? RC.bad : RC.good;
      ctx.fillText(d.budget.over ? "Перерасход" : d.live ? "Пока в рамках бюджета" : "Уложились в бюджет", X, yy); });
    y += 46;
    at(yy => { font(400, 34, RF.body); ctx.fillStyle = RC.ink;
      const t = d.hide ? `израсходовано ${d.budget.used}% бюджета`
        : d.budget.over ? `${d.budget.amount} сверх бюджета` : `${d.live ? "осталось" : "сэкономлено"} ${d.budget.amount}`;
      ctx.fillText(fit(t, TW), X, yy); });
  }
  const slipH = y + 64, TEETH = 14, footerGap = 48, footerH = 64;
  const top = Math.max(56, Math.round((H - (slipH + TEETH + footerGap + footerH)) / 2));
  // paint
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = RC.bg; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.shadowColor = "rgba(20, 30, 25, .10)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12;
  ctx.fillStyle = RC.paper; ctx.beginPath();
  ctx.moveTo(SX, top + 32); ctx.arcTo(SX, top, SX + 32, top, 32); ctx.lineTo(SX + SW - 32, top); ctx.arcTo(SX + SW, top, SX + SW, top + 32, 32);
  ctx.lineTo(SX + SW, top + slipH);
  for (let x = SX + SW; x > SX; x -= 24) { ctx.lineTo(x - 12, top + slipH + TEETH); ctx.lineTo(x - 24, top + slipH); }
  ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.save(); ctx.translate(0, top); ctx.textBaseline = "alphabetic"; ops.forEach(fn => fn()); ctx.restore();
  // footer
  const fy = top + slipH + TEETH + footerGap;
  ctx.save(); ctx.translate(SX, fy); ctx.scale(56 / 64, 56 / 64);
  ctx.fillStyle = RC.accent; ctx.beginPath(); ctx.roundRect(0, 0, 64, 64, 14); ctx.fill();
  ctx.fillStyle = RC.paper; ctx.fill(RECAP_ICON);
  ctx.fillStyle = RC.accent; [[23, 21, 18], [23, 29, 12], [23, 37, 18]].forEach(([x, yy, w]) => { ctx.beginPath(); ctx.roundRect(x, yy, w, 3, 1.5); ctx.fill(); });
  ctx.restore();
  font(700, 30, RF.disp); ctx.fillStyle = RC.ink; ctx.textAlign = "left"; ctx.fillText("Бюджет по чекам", SX + 76, fy + 26);
  font(400, 26, RF.mono); ctx.fillStyle = RC.muted; ctx.fillText("nikita5453.github.io/cheki", SX + 76, fy + 60);
}

/* ---------- the sheet ---------- */
/* One action per device: «Поделиться» where the system menu takes a file (phones, tablets), otherwise a download.
   Desktop browsers that can share files still get the download: on a computer a saved file is what people expect. */
function recapCanShare() {
  try {
    return matchMedia("(pointer: coarse)").matches && !!navigator.canShare?.({ files: [new File([""], "itogi.png", { type: "image/png" })] });
  } catch { return false; }
}

function recapFree() {
  if (R.url) URL.revokeObjectURL(R.url);
  R.url = ""; R.file = null;
}

function openRecap(k, opener) {
  const ps = periods();
  if (S.state !== "ready" || S.sheet || !ps[k]?.rs.length) return;
  if (k === ps.length - 2) { lsSet(recapKey(ps[k]), 1); renderRecapNote(); }
  Object.assign(R, { k, hide: false, busy: false, err: false, share: recapCanShare(), opener });
  recapFree();
  openSheet("recap");
  const sh = $("sheet");
  sh.classList.add("recap-sheet");
  sh.innerHTML = `
    <header class="sh-head"><h2>Итоги месяца</h2><button class="x" type="button" data-act="close" aria-label="Закрыть">×</button></header>
    <div class="recap-frame" id="recapFrame"></div>
    <div class="recap-opts"><button class="chip tall" type="button" data-act="recap-hide" aria-pressed="false">Скрыть суммы</button></div>
    <p class="hint">На картинке нет названия сборки, имён участников и магазинов.</p>
    <div class="row recap-act"><button class="btn primary" type="button" data-act="recap-share" id="recapAct">${R.share ? "Поделиться" : "Скачать картинку"}</button></div>`;
  /* «Back» on a phone closes the sheet instead of leaving the site. */
  history.pushState({ recap: true }, "");
  R.hist = true;
  sh.querySelector(".x").focus();
  recapBuild();
}

/* Updates only the parts that change, so the focus stays on the pressed control. */
function updateRecap() {
  if (S.sheet !== "recap") return;
  const frame = $("recapFrame");
  frame.innerHTML = R.err && !R.busy
    ? `<p class="notice">Не получилось собрать картинку.</p><div><button class="btn small" type="button" data-act="recap-retry">Попробовать ещё раз</button></div>`
    : R.url ? `<img class="recap-img" src="${R.url}" width="1080" height="1350" alt="${esc(R.alt)}">`
    : `<div class="recap-wait"><span class="spin"></span>Собираю картинку…</div>`;
  $("recapAct").disabled = R.busy || !R.file;
  document.querySelector("[data-act='recap-hide']")?.setAttribute("aria-pressed", String(R.hide));
}

async function recapBuild() {
  const token = ++R.token;
  R.busy = true; R.err = false;
  updateRecap();
  try {
    const d = recapData(R.k, R.hide);
    if (!d) throw new Error("no month");
    await loadRecapFonts();
    if (token !== R.token) return;
    const cv = document.createElement("canvas");
    cv.width = 1080; cv.height = 1350;
    drawRecap(cv, d);
    const blob = await new Promise((ok, fail) => cv.toBlob(b => b ? ok(b) : fail(new Error("toBlob")), "image/png"));
    if (token !== R.token) return;
    recapFree();
    R.file = new File([blob], `itogi-${d.from.slice(0, 7)}.png`, { type: "image/png" });
    R.url = URL.createObjectURL(blob);
    R.alt = `Итоги месяца ${d.period}: ${d.hide ? "" : `потрачено ${d.spent}, `}${d.countText}`;
  } catch (e) {
    if (token !== R.token) return;
    recapFree(); R.err = true;
    console.warn("recap", e);
  }
  R.busy = false;
  updateRecap();
}

function recapDownload() {
  const a = document.createElement("a");
  a.href = R.url; a.download = R.file.name;
  document.body.append(a); a.click(); a.remove();
}

/* navigator.share() is called straight from the tap (the file is ready beforehand): Safari refuses it after a wait. */
async function recapShare() {
  if (!R.file || R.busy) return;
  if (!R.share) { recapDownload(); return; }
  try {
    await navigator.share({ files: [R.file], title: "Итоги месяца", text: RECAP_TEXT });
  } catch (e) {
    if (e?.name === "AbortError") return;
    recapDownload();
    toast("Меню «Поделиться» не открылось, картинка скачана");
  }
}

/* The sheet can close by the cross, Esc or «Back»: whichever it was, clean up when it hides. */
function recapClosed() {
  const k = R.k;
  R.token++; R.k = null;
  $("sheet").classList.remove("recap-sheet");
  recapFree();
  if (R.hist) { R.hist = false; history.back(); }
  const o = R.opener; R.opener = null;
  const back = o?.isConnected && o.offsetParent ? o
    : document.querySelector(`.recap-btn[data-k="${k}"]`) || document.querySelector(".recap-btn");
  back?.focus();
}
{
  const wrap = document.getElementById("sheetWrap");
  new MutationObserver(() => { if (wrap.hidden && R.k != null) recapClosed(); }).observe(wrap, { attributes: true, attributeFilter: ["hidden"] });
}
addEventListener("popstate", () => {
  if (!R.hist) return;
  R.hist = false;
  if (S.sheet === "recap") closeSheet();
});

/* ---------- the note in the first 7 days of a month ---------- */
const recapKey = p => `recapSeen:${S.bookId}:${p.from}`;
let recapNoteHtml = "";
function renderRecapNote(st) {
  const el = $("recapNote"), ps = st?.ps || periods();
  const cur = ps[ps.length - 1], prev = ps[ps.length - 2];
  const show = S.state === "ready" && !!prev && prev.rs.length > 0
    && Math.round((parseD(today()) - parseD(cur.from)) / 864e5) < 7 && !lsGet(recapKey(prev), 0);
  const html = show ? `
    <span class="recap-text">Итоги месяца ${periodLabel(prev)} готовы</span>
    <span class="recap-go">
      <button class="btn small primary" type="button" data-act="recap" data-k="${prev.k}">Посмотреть</button>
      <button class="x" type="button" data-act="recap-dismiss" data-k="${prev.k}" aria-label="Скрыть">×</button>
    </span>` : "";
  if (recapNoteHtml !== html) el.innerHTML = recapNoteHtml = html;
  el.hidden = !show;
}

document.addEventListener("click", e => {
  const t = e.target.closest("[data-act^='recap']"); if (!t) return;
  switch (t.dataset.act) {
    case "recap": openRecap(+t.dataset.k, t); break;
    case "recap-dismiss": {
      const p = periods()[+t.dataset.k];
      if (p) lsSet(recapKey(p), 1);
      renderRecapNote();
      $("budgetCard").querySelector("button")?.focus();
      break;
    }
    case "recap-hide": if (S.sheet === "recap") { R.hide = !R.hide; recapBuild(); } break;
    case "recap-share": recapShare(); break;
    case "recap-retry": recapBuild(); break;
  }
});
