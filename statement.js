"use strict";
/* Разбор банковской выписки (CSV или Excel) прямо в браузере: поиск строки заголовков, колонок даты, описания
   и суммы, перевод строк в операции и подбор вида затрат. Без обращений к серверу.
   Чистые функции: в браузере доступны как window.Statement, в Node — через require. */

const Statement = (() => {
  /* ---------- текст и таблицы ---------- */
  /* Банки отдают CSV в UTF-8 или в Windows-1251; пробуем строгий UTF-8, иначе 1251. */
  function decode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } // TextDecoder сам убирает BOM
    catch { return new TextDecoder("windows-1251").decode(bytes); }
  }

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
    const count = (s, ch) => s.split(ch).length - 1;
    const delim = [";", ",", "\t"].map(d => [d, lines.reduce((n, l) => n + count(l, d), 0)]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(v => String(v).trim()));
  }

  /* ---------- значения ---------- */
  const pad = n => String(n).padStart(2, "0");
  const iso = (y, m, d) => (y >= 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${pad(m)}-${pad(d)}` : null;

  /* → { date: "ГГГГ-ММ-ДД", time: "ЧЧ:ММ" | "" } или null. Понимает Date, номер дня Excel и строки
     «05.11.2026 14:22:01», «05.11.26», «2026-11-05T14:22», «05/11/2026». */
  function parseDate(v) {
    if (v instanceof Date && !isNaN(v)) {
      const t = new Date(v.getTime() + 30000); // SheetJS иногда отдаёт время на несколько секунд раньше
      return { date: iso(t.getFullYear(), t.getMonth() + 1, t.getDate()), time: `${pad(t.getHours())}:${pad(t.getMinutes())}` };
    }
    if (typeof v === "number" && v > 30000 && v < 80000) {
      const t = new Date(Math.round((v - 25569) * 864e5));
      const time = v % 1 ? `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` : "";
      return { date: iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()), time };
    }
    const s = String(v ?? "").trim();
    let m, date = null;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) date = iso(+m[1], +m[2], +m[3]);
    else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/))) date = iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
    if (!date) return null;
    const tm = s.slice(m[0].length).match(/(\d{1,2}):(\d{2})/);
    return { date, time: tm ? `${pad(tm[1])}:${tm[2]}` : "" };
  }

  /* «−1 234,56», «-1234.56», «1 234,56 UAH», «(150,00)» → число или null. */
  function parseAmount(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    let s = String(v ?? "").trim();
    if (!s) return null;
    let neg = /^\(.*\)$/.test(s);
    s = s.replace(/[−–—]/g, "-").replace(/[\s  ']/g, "").replace(/[^\d,.\-+]/g, "");
    if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
    s = s.replace(/^\+/, "");
    if (!/\d/.test(s) || /-/.test(s)) return null;
    const lastC = s.lastIndexOf(","), lastD = s.lastIndexOf(".");
    if (lastC >= 0 && lastD >= 0) s = lastC > lastD ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (lastC >= 0) s = s.replace(",", ".");
    const n = parseFloat(s);
    return isFinite(n) ? (neg ? -n : n) : null;
  }

  /* ---------- колонки ---------- */
  const H = {
    date: /дата|date|час операц|time/i,
    desc: /опис|описание|деталі|детали|призначен|назначен|description|details|merchant|контрагент|отримувач|получател|назва|название/i,
    amount: /сума|сумма|amount|sum\b/i,
    debit: /списан|витрат|расход|дебет|debit|видат/i,
    credit: /зарахув|зачислен|надходж|поступлен|кредит|credit|прихід|приход/i,
    cat: /категор|category/i,
    mcc: /^\s*mcc\s*$/i
  };
  const NOT_AMOUNT = /коміс|комисс|кешбек|кэшбэк|cashback|залишок|остаток|баланс|balance|курс|rate|fee/i;

  /* Ищет в первых строках строку заголовков и раскладывает колонки по ролям. */
  function detect(rows) {
    let best = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const cells = rows[i].map(c => String(c ?? "").trim());
      const map = guess(cells);
      const score = (map.date >= 0) + (map.desc >= 0) + (map.amount >= 0 || map.debit >= 0) * 2 + (map.cat >= 0) + (map.mcc >= 0);
      if (map.date >= 0 && (map.amount >= 0 || map.debit >= 0) && (!best || score > best.score)) best = { header: i, map, score };
    }
    if (best) return { header: best.header, map: best.map };
    return { header: -1, map: { date: -1, desc: -1, amount: -1, debit: -1, credit: -1, cat: -1, mcc: -1 } };
  }

  function guess(cells) {
    const find = (re, skip = () => false, prefer) => {
      const all = cells.map((c, i) => [c, i]).filter(([c, i]) => c && c.length < 80 && re.test(c) && !skip(c, i));
      if (!all.length) return -1;
      const p = prefer && all.find(([c]) => prefer.test(c));
      return (p || all[0])[1];
    };
    const map = {};
    map.date = find(H.date, c => /обробк|обработк|списан|залишок|остаток/i.test(c), /операц|транзакц|transaction|^дата$/i);
    map.mcc = find(H.mcc);
    map.cat = find(H.cat);
    map.debit = find(H.debit, c => NOT_AMOUNT.test(c));
    map.credit = find(H.credit, c => NOT_AMOUNT.test(c));
    if (map.debit >= 0 && map.credit < 0) map.debit = -1; // одиночное «Списание» без пары — скорее дата или признак
    map.amount = map.debit >= 0 ? -1 : find(H.amount, c => NOT_AMOUNT.test(c) || /валют[іиі] операц|валюте операц|transaction currency/i.test(c),
      /картк|карты|рахунк|счет|счёт|uah|грн/i);
    map.desc = find(H.desc, (c, i) => [map.date, map.amount, map.debit, map.credit, map.cat, map.mcc].includes(i));
    return map;
  }

  /* ---------- операции ---------- */
  /* sign: "auto" (минус — трата, плюс — поступление; если минусов нет, все суммы — траты), "minus", "all". */
  function operations(rows, header, map, sign = "auto") {
    const body = rows.slice(header + 1);
    const cell = (r, i) => (i >= 0 ? r[i] : "");
    const raw = [];
    let skipped = 0;
    for (const r of body) {
      const d = parseDate(cell(r, map.date));
      let amount;
      if (map.debit >= 0) {
        const deb = parseAmount(cell(r, map.debit)), cred = parseAmount(cell(r, map.credit));
        amount = deb ? -Math.abs(deb) : cred ? Math.abs(cred) : null;
      } else amount = parseAmount(cell(r, map.amount));
      if (!d || amount == null || amount === 0) { skipped++; continue; }
      raw.push({
        date: d.date, time: d.time, amount,
        desc: String(cell(r, map.desc) ?? "").replace(/\s+/g, " ").trim(),
        bankCat: String(cell(r, map.cat) ?? "").trim(),
        mcc: String(cell(r, map.mcc) ?? "").replace(/\D/g, "")
      });
    }
    const anyNeg = raw.some(o => o.amount < 0);
    const mode = sign === "auto" ? (anyNeg || map.debit >= 0 ? "minus" : "all") : sign;
    const ops = [];
    let income = 0;
    for (const o of raw) {
      const isExpense = mode === "all" ? true : o.amount < 0;
      if (!isExpense) { income++; continue; }
      ops.push({ ...o, amount: Math.round(Math.abs(o.amount) * 100) / 100, kind: kindOf(o) });
    }
    return { ops, income, skipped, mode };
  }

  /* ---------- виды операций и затрат ---------- */
  const CASH_MCC = new Set(["6010", "6011"]);
  const TRANSFER_MCC = new Set(["4829", "6012", "6050", "6051", "6529", "6530", "6532", "6533", "6534", "6536", "6537", "6538", "6540"]);
  function kindOf(o) {
    const t = `${o.desc} ${o.bankCat}`;
    if (CASH_MCC.has(o.mcc) || /банкомат|atm\b|зняття готівки|снятие наличн|видача готівки|cash withdrawal/i.test(t)) return "cash";
    if (TRANSFER_MCC.has(o.mcc) || /переказ|перевод|на картку|на карту|з картки|с карты|поповнення|пополнение|p2p|transfer|між своїми|между своими|депозит|скарбничк|копилк|банк[аи] на /i.test(t)) return "transfer";
    return "spend";
  }

  const MCC = [
    ["Продукты", "5411 5412 5422 5441 5451 5462 5499 5300"],
    ["Кафе и доставка", "5811 5812 5813 5814"],
    ["Аптека и здоровье", "5122 5912 5975 5976 8011 8021 8031 8041 8042 8043 8049 8050 8062 8071 8099"],
    ["Транспорт и топливо", "4011 4111 4112 4121 4131 4784 4789 5013 5172 5531 5532 5533 5541 5542 5983 7511 7523 7531 7534 7535 7538 7542 3000"],
    ["Одежда и обувь", "5131 5137 5139 5611 5621 5631 5651 5655 5661 5681 5691 5697 5698 5699 5931 5948"],
    ["Дом и ремонт", "1520 1711 1731 1740 1750 1761 1771 5021 5039 5051 5065 5072 5198 5200 5211 5231 5251 5261 5712 5713 5714 5718 5719 5722 5732 7629 7641"],
    ["Связь и подписки", "4812 4814 4815 4816 4821 4899 4900 5815 5816 5817 5818 5968 7372"],
    ["Дети", "5641 5945 8211 8351"],
    ["Животные", "0742 5995"],
    ["Красота и уход", "5977 7230 7297 7298"],
    ["Развлечения", "5735 5815 7832 7841 7911 7922 7929 7932 7933 7941 7991 7992 7994 7996 7997 7998 7999 4722 7011 3501"],
    ["Хозтовары и бытовая химия", "5310 5311 5331 5399 5169"]
  ];
  const MCC_CAT = new Map();
  for (const [cat, list] of MCC) for (const code of list.split(" ")) if (!MCC_CAT.has(code)) MCC_CAT.set(code, cat);

  const WORDS = [
    ["Кафе и доставка", /bolt ?food|glovo|uber ?eats|raketa|ракета|кафе|кав'ярн|кофейн|coffee|кава|ресторан|restaurant| бар | pub |піц|пицц|pizza|суші|суши|sushi|mcdonald|макдональдс|kfc|burger|доставк[аи] їжі|фастфуд|фаст-фуд/i],
    ["Продукты", /продукт|супермаркет|гіпермаркет|гипермаркет|сільпо|сильпо|silpo| атб | atb |novus|новус|фора| fora |ашан|auchan|metro cash|метро кеш|варус|varus|eko ?market|еко ?маркет|копійк|копейк|наш край|рукавичка|велмарт|велика кишеня|таврія|трош| spar |лоток|marketopt|продмаг/i],
    ["Аптека и здоровье", /аптек|apteka|pharm|ліки|лекарств|клінік|клиник|медичн|медицин|стоматол|лаборатор|synevo|сінево|діла| dila |подорожник|бажаємо здоров/i],
    ["Транспорт и топливо", / азс |wog|okko|socar| upg | klo |brsm|авіас|авиас|пальне|топливо|паливо|fuel|uklon|uber| bolt |таксі|такси|taxi|метрополітен|метрополитен|транспорт|укрзалізниц|укрзализныц|uz\.gov|parking|паркув|парковк|автобус|проїзд|проезд|шиномонтаж|автомийк|автомойк/i],
    ["Связь и подписки", /київстар|киевстар|kyivstar|vodafone|водафон|lifecell|лайфселл|мобільн|мобильн|зв'язок|связь|інтернет|интернет|netflix|spotify|youtube|google ?(one|play|storage)|apple\.com|icloud|itunes|megogo|мегого|sweet\.tv|oll\.tv|kyivstar ?tv|chatgpt|openai|anthropic|claude\.ai|підписк|подписк|subscription|воля|volia|triolan|тріолан|ланет|lanet|укртелеком/i],
    ["Одежда и обувь", /одяг|одежд|взутт|обув|zara|h&m|lc ?waikiki|reserved|sinsay|intertop|colin'?s|answear|pull ?& ?bear|bershka|stradivarius|mango|cropp| house |terranova|defacto|kasta|каста/i],
    ["Дом и ремонт", /епіцентр|эпицентр|epicentr|нова лінія|новая линия|leroy|jysk|ikea|меблі|мебел|будів|строит|comfy|фокстрот|foxtrot|eldorado|ельдорадо|rozetka|розетка| allo | алло |citrus|цитрус|комунал|коммунал|водоканал|нафтогаз|газзбут|газопостач|енергозбут|энергосбыт|yasno| ясно |dtek|дтек|квартплат|осбб/i],
    ["Хозтовары и бытовая химия", / eva |єва|prostor|простор|watsons|ватсонс|бытов.{0,3}хим|побутов.{0,3}хім|господар|хозтовар|аврора|aurora|blyzenko|копеечк/i],
    ["Красота и уход", /салон|перукар|парикмах|барбер|barber|манікюр|маникюр|косметик|косметолог|beauty|makeup|notino|make ?up|brocard|брокард/i],
    ["Животные", / зоо| zoo|ветеринар| vet |masterzoo|мастерзоо|petslike|котик|собак/i],
    ["Дети", /дитяч|детск|іграшк|игрушк|antoshka|антошка|будинок іграшок|smyk|смик|школ[аи]|садок|садик/i],
    ["Развлечения", /кіно|кино|multiplex|мультиплекс|planeta ?kino|планета кіно|театр|концерт|karabas|карабас|concert\.ua|steam|playstation|xbox|nintendo|розваг|развлеч|боулінг|боулинг|квест|книгарн|книжн|yakaboo|якабу|готель|отель|hotel|booking/i]
  ];

  /* Вид затрат для операции: сначала по коду MCC, потом по словам в описании и категории банка. */
  function category(o, cats) {
    const ok = c => !cats || cats.includes(c);
    const byMcc = MCC_CAT.get(o.mcc);
    if (byMcc && ok(byMcc)) return byMcc;
    /* Пробелы по краям слов вместо : в JavaScript  не видит границ кириллических слов. */
    const t = " " + `${o.desc} ${o.bankCat}`.toLowerCase().replace(/[^\p{L}\p{N}&'.]+/gu, " ").replace(/\.(?=\s|$)/g, " ") + " ";
    for (const [cat, re] of WORDS) if (re.test(t) && ok(cat)) return cat;
    return "Другое";
  }

  return { decode, parseCsv, parseDate, parseAmount, detect, guess, operations, category, kindOf };
})();

if (typeof module !== "undefined") module.exports = Statement;
