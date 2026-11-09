// What Gemini is asked about a receipt photo and how its answer is checked. Shared by the `recognize` Edge Function
// (Deno) and the one-off re-recognition script (Node), so it stays portable: plain functions and constants only,
// no Deno.* and no npm:/jsr: imports, nothing but erasable TypeScript.

export const EXP = ["Продукты", "Хозтовары и бытовая химия", "Кафе и доставка", "Аптека и здоровье", "Транспорт и топливо",
  "Одежда и обувь", "Дом и ремонт", "Связь и подписки", "Дети", "Животные", "Красота и уход", "Развлечения", "Другое"];
export const FOOD = ["Молочное", "Яйца", "Мясо и птица", "Рыба и морепродукты", "Овощи", "Фрукты и ягоды", "Хлеб и выпечка",
  "Крупы, макароны, мука", "Бакалея и консервы", "Масло, соусы, специи", "Сладости и снеки", "Чай и кофе", "Напитки",
  "Алкоголь", "Готовая еда", "Замороженное"];

export const GENERATION_CONFIG = { responseMimeType: "application/json", temperature: 0 };
/** The generateContent request body: the prompt and photos as `parts`, with the shared settings. */
export const geminiBody = (parts: unknown[]) => ({ contents: [{ parts }], generationConfig: GENERATION_CONFIG });

export function prompt(today: string) {
  return `Перед тобой фото кассового чека. Если фото несколько, это части одного длинного чека по порядку.
Верни только JSON такого вида:
{"store": "Название магазина", "date": "YYYY-MM-DD", "total": 1234.5, "items": [{"name": "Молоко 2,5% 0,9 л ×2", "price": 85.8, "category": "Продукты", "type": "Молочное", "product": "молоко 2,5%", "brand": "Галичина", "qty": 2, "unit": "шт"}, {"name": "Бананы", "price": 70.2, "category": "Продукты", "type": "Фрукты и ягоды", "product": "бананы", "qty": 1.08, "unit": "кг"}]}

Правила:
- Валюта — гривны. Чек может быть на украинском или русском; name пиши по-русски.
- store: короткое название магазина или заведения, как его называют люди (без ТОВ/ФОП, адреса и кодов).
- date: дата покупки из чека в формате YYYY-MM-DD; если не читается, null. Сегодня ${today}.
- items: каждая строка товара или услуги. price — итоговая сумма по строке с учётом количества и скидки на строку, числом. name — понятное короткое название без артикулов и кодов; если количество больше одного, допиши «×N».
- category: строго одно значение из списка: ${EXP.join("; ")}.
- type: вид продукта. Для еды и напитков строго одно значение из списка: ${FOOD.join("; ")}. Сливочное масло, сыр, йогурт, кефир, сметана — «Молочное». Для остального — короткий общий вид в 1–3 слова, например «Моющие средства», «Лекарства», «Бензин», «Корм».
- product: что это за товар, общим именем по-русски строчными буквами, без бренда, фасовки и количества: «молоко 2,5%», «картофель», «булочка с маком», «бензин а-95». Один и тот же товар из разных магазинов называй одинаково.
- brand: бренд или производитель, как в чеке. Если бренда в чеке нет, поле не пиши.
- qty и unit: сколько куплено и в чём, только парой. unit строго одно из: шт, кг, л. Весовой товар («0,734 × 89,90») — вес в кг: qty 0.734, unit «кг». Штучный или фасованный товар — число штук: «Булочка ×7» — qty 7, unit «шт»; две пачки молока 0,9 л — qty 2, unit «шт», а фасовка остаётся в name. Одна штука и количества в чеке нет — qty 1, unit «шт». Розлив по объёму (топливо 30,5 л) — qty 30.5, unit «л». Граммы и миллилитры переводи в кг и л.
- Если не уверен в product, brand или количестве — не пиши это поле, ничего не выдумывай. Вес, который в чеке не читается, не угадывай. Цену за единицу не возвращай.
- Если в чеке есть общая скидка, оплата бонусами или округление, добавь отдельную строку с отрицательной price (name «Скидка»), category и type как у большей части покупок, чтобы сумма всех price равнялась total. У строки скидки product, brand, qty и unit не пиши.
- total: сумма к оплате по чеку, числом.
- Если на фото не чек или его невозможно прочитать, верни {"error": "коротко, что не так"}.`;
}

const num = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const words = (v: unknown) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";

/** A quantity as Gemini wrote it: a number, or a string like "0,734". Anything else is NaN. */
function qtyNum(v: unknown) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const s = v.replace(/\s/g, "").replace(",", ".");
  return s ? Number(s) : NaN;
}

const UNITS: Record<string, [string, number]> = {
  "шт": ["шт", 1], "pcs": ["шт", 1], "кг": ["кг", 1], "kg": ["кг", 1], "л": ["л", 1], "l": ["л", 1],
  "г": ["кг", 1000], "гр": ["кг", 1000], "мл": ["л", 1000],
};

/** The checked qty/unit pair, or null when it is missing, invalid or contradicts a trailing «×N» in the name. */
function quantity(it: Record<string, unknown>, name: string): { qty: number; unit: string } | null {
  if (typeof it.unit !== "string") return null;
  const u = UNITS[it.unit.trim().toLowerCase().replace(/\.$/, "")];
  let qty = qtyNum(it.qty);
  if (!u || !isFinite(qty) || qty <= 0) return null;
  const unit = u[0];
  qty /= u[1];
  if (unit === "шт") {
    if (!Number.isInteger(qty) || qty > 1000) return null;
  } else {
    qty = r3(qty);
    if (qty <= 0 || qty > 100) return null;
  }
  const x = name.match(/[×xх]\s*(\d+(?:[.,]\d+)?)\s*$/i);
  if (x) {
    const n = Number(x[1].replace(",", "."));
    if (Math.abs(n - qty) > 0.001 || (unit === "шт" && !Number.isInteger(n))) return null;
  }
  return { qty, unit };
}

/*
 * Item format in receipts.items (CHK-11, approved by Architect in issue #14):
 *   { name, price, category, type,          // as before
 *     product?, brand?, qty?, unit?, unitPrice? }
 * New fields are optional: a missing field means "unknown"; empty strings, null and 0 are never stored.
 * - product: lower case, whitespace collapsed, at most 60 characters.
 * - brand: as on the receipt, whitespace collapsed, at most 40 characters; "-" and "нет" mean none.
 * - qty + unit come only as a pair. unit is шт, кг or л (г and мл become кг and л). шт: a whole number 1–1000;
 *   кг and л: rounded to 0.001, at most 100. A pair that contradicts a trailing «×N» in the name is dropped.
 * - unitPrice = price / qty rounded to 0.01, computed here (Gemini's value is ignored), only with a valid pair.
 * - Lines with price <= 0 (discounts) get none of the new fields. Each field is checked on its own.
 * Only these keys reach the stored item; anything else in Gemini's answer is dropped.
 */
function item(it: Record<string, unknown>) {
  const out: Record<string, unknown> = {
    name: String(it.name ?? "").trim() || "Позиция",
    price: num(it.price),
    category: EXP.includes(String(it.category)) ? String(it.category) : "Другое",
    type: String(it.type ?? "").trim(),
  };
  const price = out.price as number;
  if (price <= 0) return out;
  const product = words(it.product).toLowerCase().slice(0, 60).trim();
  if (product) out.product = product;
  const brand = words(it.brand).slice(0, 40).trim();
  if (brand && !["-", "—", "нет"].includes(brand.toLowerCase())) out.brand = brand;
  const q = quantity(it, out.name as string);
  if (q) { out.qty = q.qty; out.unit = q.unit; out.unitPrice = r2(price / q.qty); }
  return out;
}

export function clean(res: Record<string, unknown>) {
  const items = (Array.isArray(res.items) ? res.items : [])
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map(item)
    .filter(it => it.name !== "Позиция" || it.price);
  const total = res.total != null ? num(res.total) : r2(items.reduce((s, i) => s + (i.price as number), 0));
  const d = String(res.date ?? "");
  return { store: String(res.store ?? "").trim(), date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null, total, items };
}
