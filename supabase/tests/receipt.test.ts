// Checks how the recognize function cleans a Gemini answer (CHK-11 item fields). No network, no keys.
// Run from the repo root (Node 22.18+ runs .ts as is): node --test supabase/tests/receipt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, geminiBody, prompt } from "../functions/recognize/receipt.ts";

const base = { name: "Товар", price: 100, category: "Продукты", type: "Молочное" };
/** The cleaned single item for a fake Gemini answer with these extra item fields. */
const one = (extra: Record<string, unknown>) => clean({ store: "Магазин", date: "2026-11-09", total: 100, items: [{ ...base, ...extra }] }).items[0];
const NEW = ["product", "brand", "qty", "unit", "unitPrice"];
const pick = (it: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => k in it).map(k => [k, it[k]]));

test("old fields and totals are unchanged", () => {
  const c = clean({
    store: " АТБ ", date: "2026-11-09", total: "150,5",
    items: [{ name: "Молоко", price: "100,5", category: "Продукты", type: "Молочное" }, { name: "Что-то", price: 50, category: "Нет такой" }, null, { name: "", price: 0 }],
  });
  assert.deepEqual(c, {
    store: "АТБ", date: "2026-11-09", total: 150.5,
    items: [{ name: "Молоко", price: 100.5, category: "Продукты", type: "Молочное" }, { name: "Что-то", price: 50, category: "Другое", type: "" }],
  });
  assert.equal(clean({ date: "вчера", items: [{ name: "А", price: 1.1 }, { name: "Б", price: 2.2 }] }).total, 3.3);
  assert.equal(clean({ date: "вчера", items: [] }).date, null);
});

test("an item without new fields stays as before", () => {
  assert.deepEqual(one({}), base);
});

test("a full packaged item", () => {
  const it = one({ name: "Молоко 2,5% 0,9 л ×2", price: 85.8, product: "  Молоко   2,5% ", brand: " Галичина ", qty: 2, unit: "шт", unitPrice: 999 });
  assert.deepEqual(pick(it, NEW), { product: "молоко 2,5%", brand: "Галичина", qty: 2, unit: "шт", unitPrice: 42.9 });
});

test("a weighed item: string qty with a comma, unitPrice from price / qty", () => {
  assert.deepEqual(pick(one({ price: 65.99, qty: "0,734", unit: "кг" }), NEW), { qty: 0.734, unit: "кг", unitPrice: 89.9 });
});

test("grams become kilograms and millilitres become litres", () => {
  assert.deepEqual(pick(one({ price: 65.99, qty: 734, unit: "г" }), ["qty", "unit"]), { qty: 0.734, unit: "кг" });
  assert.deepEqual(pick(one({ qty: 1500, unit: "гр" }), ["qty", "unit"]), { qty: 1.5, unit: "кг" });
  assert.deepEqual(pick(one({ qty: 500, unit: "мл" }), ["qty", "unit"]), { qty: 0.5, unit: "л" });
});

test("unit synonyms", () => {
  for (const [u, want] of [["шт.", "шт"], ["pcs", "шт"], ["kg", "кг"], ["l", "л"], ["л.", "л"], ["КГ", "кг"]]) {
    assert.equal(one({ qty: 1, unit: u }).unit, want, u);
  }
});

test("zero, negative or non-numeric qty drops the pair", () => {
  for (const qty of [0, -1, "0", "", "два", null, undefined, true]) {
    const it = one({ qty, unit: "шт", product: "товар" });
    assert.deepEqual(pick(it, NEW), { product: "товар" }, String(qty));
  }
});

test("a fractional count in шт drops the pair, and so does more than 1000", () => {
  assert.deepEqual(pick(one({ qty: 1.5, unit: "шт" }), NEW), {});
  assert.deepEqual(pick(one({ qty: 1001, unit: "шт" }), NEW), {});
  assert.deepEqual(pick(one({ qty: 1000, unit: "шт" }), ["qty"]), { qty: 1000 });
});

test("more than 100 kg or l drops the pair; kg is rounded to 0.001", () => {
  assert.deepEqual(pick(one({ qty: 100.5, unit: "кг" }), NEW), {});
  assert.equal(one({ qty: 0.12345, unit: "кг" }).qty, 0.123);
  assert.deepEqual(pick(one({ qty: 0.0001, unit: "кг" }), NEW), {});
});

test("an unknown unit or half a pair drops the pair", () => {
  assert.deepEqual(pick(one({ qty: 2, unit: "упак" }), NEW), {});
  assert.deepEqual(pick(one({ qty: 2 }), NEW), {});
  assert.deepEqual(pick(one({ unit: "шт" }), NEW), {});
  assert.deepEqual(pick(one({ qty: 2, unit: 5 }), NEW), {});
});

test("a unit named like an Object.prototype member drops the pair (no NaN or null is stored)", () => {
  for (const unit of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
    const it = one({ qty: 2, unit, product: "хлеб" });
    assert.deepEqual(pick(it, NEW), { product: "хлеб" }, unit);
    assert.ok(Object.values(it).every(v => v !== null && !Number.isNaN(v)), unit);
  }
});

test("qty strings must be plain decimals", () => {
  for (const qty of ["0x10", "1e2", "0b11", "Infinity", "2шт", "1.2.3", "-1", "+2"]) {
    assert.deepEqual(pick(one({ qty, unit: "шт" }), NEW), {}, qty);
  }
  for (const qty of [Infinity, NaN]) assert.deepEqual(pick(one({ qty, unit: "кг" }), NEW), {}, String(qty));
  assert.equal(one({ qty: " 1 000 ", unit: "шт" }).qty, 1000);
});

test("«×N» counts only after a non-letter, so «Горох 400» is not a quantity", () => {
  assert.deepEqual(pick(one({ name: "Горох 400", qty: 1, unit: "шт" }), ["qty"]), { qty: 1 });
  assert.deepEqual(pick(one({ name: "Pepsi Max 2", qty: 1, unit: "шт" }), ["qty"]), { qty: 1 });
  assert.deepEqual(pick(one({ name: "Big Box 2", qty: 1, unit: "шт" }), ["qty"]), { qty: 1 });
  assert.deepEqual(pick(one({ name: "Хлеб ×2", qty: 1, unit: "шт" }), NEW), {});
  assert.deepEqual(pick(one({ name: "×3", qty: 1, unit: "шт" }), NEW), {});
});

test("a trailing «×N» in the name must agree with qty", () => {
  assert.deepEqual(pick(one({ name: "Бананы ×1.08", qty: 1, unit: "кг" }), NEW), {});
  assert.deepEqual(pick(one({ name: "Бананы ×1,08", qty: 1.08, unit: "кг" }), ["qty", "unit"]), { qty: 1.08, unit: "кг" });
  assert.deepEqual(pick(one({ name: "Бананы ×1.08", qty: 1, unit: "шт" }), NEW), {});
  assert.deepEqual(pick(one({ name: "Булочка ×7", qty: 7, unit: "шт" }), ["qty"]), { qty: 7 });
  assert.deepEqual(pick(one({ name: "Булочка x7", qty: 6, unit: "шт" }), NEW), {});
  assert.deepEqual(pick(one({ name: "Гречка 5×80 г", qty: 1, unit: "шт" }), ["qty"]), { qty: 1 });
});

test("a discount line and any line with price <= 0 gets no new fields", () => {
  const it = one({ name: "Скидка", price: -20, product: "скидка", brand: "АТБ", qty: 1, unit: "шт" });
  assert.deepEqual(it, { name: "Скидка", price: -20, category: "Продукты", type: "Молочное" });
  assert.deepEqual(pick(one({ price: 0, product: "товар", qty: 1, unit: "шт" }), NEW), {});
});

test("empty or non-string product and brand are not stored", () => {
  for (const v of ["", "   ", null, 5, ["молоко"], { a: 1 }]) {
    assert.deepEqual(pick(one({ product: v, brand: v }), NEW), {}, JSON.stringify(v));
  }
  for (const b of ["-", "—", "нет", "Нет"]) assert.equal("brand" in one({ brand: b }), false, b);
});

test("product is cut to 60 characters, brand to 40", () => {
  const long = "Очень длинное название товара которое никак не помещается в шестьдесят символов";
  const p = one({ product: long, brand: "Б".repeat(50) });
  assert.equal(p.product, long.toLowerCase().slice(0, 60).trim());
  assert.ok((p.product as string).length <= 60);
  assert.equal(p.brand, "Б".repeat(40));
});

test("fields are checked independently", () => {
  assert.deepEqual(pick(one({ product: "сыр", brand: "", qty: 0, unit: "кг" }), NEW), { product: "сыр" });
  assert.deepEqual(pick(one({ product: "", brand: "Ферма", qty: 2, unit: "шт" }), NEW), { brand: "Ферма", qty: 2, unit: "шт", unitPrice: 50 });
});

test("extra keys from Gemini never reach the stored item", () => {
  const it = one({ unitPrice: 1, note: "x", __proto__: { polluted: true }, author: "u2", product: "сыр" });
  assert.deepEqual(Object.keys(it).sort(), ["category", "name", "price", "product", "type"]);
});

test("the prompt and request body", () => {
  const p = prompt("2026-11-09");
  assert.match(p, /Сегодня 2026-11-09/);
  for (const w of ["product", "brand", "qty", "unit", "«кг»", "не пиши это поле"]) assert.ok(p.includes(w), w);
  assert.doesNotMatch(p, /unitPrice/);
  assert.deepEqual(geminiBody([{ text: "t" }]), { contents: [{ parts: [{ text: "t" }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } });
});
