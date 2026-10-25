// Распознавание чека через Gemini. Сайт вызывает функцию сразу после загрузки фото: { id: "<id чека>" }.
// Ключ Gemini хранится в секретах проекта (GEMINI_API_KEY) и в браузер не попадает.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const EXP = ["Продукты", "Хозтовары и бытовая химия", "Кафе и доставка", "Аптека и здоровье", "Транспорт и топливо",
  "Одежда и обувь", "Дом и ремонт", "Связь и подписки", "Дети", "Животные", "Красота и уход", "Развлечения", "Другое"];
const FOOD = ["Молочное", "Яйца", "Мясо и птица", "Рыба и морепродукты", "Овощи", "Фрукты и ягоды", "Хлеб и выпечка",
  "Крупы, макароны, мука", "Бакалея и консервы", "Масло, соусы, специи", "Сладости и снеки", "Чай и кофе", "Напитки",
  "Алкоголь", "Готовая еда", "Замороженное"];

const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite";
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "20");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function prompt(today: string) {
  return `Перед тобой фото кассового чека. Если фото несколько, это части одного длинного чека по порядку.
Верни только JSON такого вида:
{"store": "Название магазина", "date": "YYYY-MM-DD", "total": 1234.5, "items": [{"name": "Молоко 2,5% 0,9 л", "price": 42.9, "category": "Продукты", "type": "Молочное"}]}

Правила:
- Валюта — гривны. Чек может быть на украинском или русском; name пиши по-русски.
- store: короткое название магазина или заведения, как его называют люди (без ТОВ/ФОП, адреса и кодов).
- date: дата покупки из чека в формате YYYY-MM-DD; если не читается, null. Сегодня ${today}.
- items: каждая строка товара или услуги. price — итоговая сумма по строке с учётом количества и скидки на строку, числом. name — понятное короткое название без артикулов и кодов; если количество больше одного, допиши «×N».
- category: строго одно значение из списка: ${EXP.join("; ")}.
- type: вид продукта. Для еды и напитков строго одно значение из списка: ${FOOD.join("; ")}. Сливочное масло, сыр, йогурт, кефир, сметана — «Молочное». Для остального — короткий общий вид в 1–3 слова, например «Моющие средства», «Лекарства», «Бензин», «Корм».
- Если в чеке есть общая скидка, оплата бонусами или округление, добавь отдельную строку с отрицательной price (name «Скидка»), category и type как у большей части покупок, чтобы сумма всех price равнялась total.
- total: сумма к оплате по чеку, числом.
- Если на фото не чек или его невозможно прочитать, верни {"error": "коротко, что не так"}.`;
}

const num = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };

function clean(res: Record<string, unknown>) {
  const items = (Array.isArray(res.items) ? res.items : [])
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map(it => ({
      name: String(it.name ?? "").trim() || "Позиция",
      price: num(it.price),
      category: EXP.includes(String(it.category)) ? String(it.category) : "Другое",
      type: String(it.type ?? "").trim(),
    }))
    .filter(it => it.name !== "Позиция" || it.price);
  const total = res.total != null ? num(res.total) : Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100;
  const d = String(res.date ?? "");
  return { store: String(res.store ?? "").trim(), date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null, total, items };
}

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "not signed in" }, 401);
  const { id } = await req.json().catch(() => ({ id: null }));
  if (!id) return json({ error: "no receipt id" }, 400);

  // Row level security decides whether this person may see the receipt at all.
  const { data: rec } = await asUser.from("receipts").select("id, status, photos").eq("id", id).maybeSingle();
  if (!rec) return json({ error: "receipt not found" }, 404);
  if (rec.status !== "pending") return json({ status: rec.status });

  const fail = async (error: string) => {
    await admin.from("receipts").update({ status: "error", error, updated_at: new Date().toISOString() })
      .eq("id", id).eq("status", "pending");
    return json({ status: "error", error });
  };

  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await admin.from("recognitions").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= DAILY_LIMIT) {
    return fail(`за сутки можно распознать до ${DAILY_LIMIT} чеков. Заполните этот чек вручную или повторите завтра`);
  }

  const parts: unknown[] = [{ text: prompt(new Date().toISOString().slice(0, 10)) }];
  for (const p of (rec.photos ?? []).slice(0, 4)) {
    const { data: blob } = await admin.storage.from("photos").download(p);
    if (blob) parts.push({ inline_data: { mime_type: "image/jpeg", data: base64(new Uint8Array(await blob.arrayBuffer())) } });
  }
  if (parts.length < 2) return fail("фото чека не найдено");

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY") ?? "" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }),
  });
  if (r.status === 429) return fail("сервис распознавания сейчас перегружен. Нажмите «Распознать ещё раз» через минуту");
  if (!r.ok) return fail(`сервис распознавания вернул ошибку ${r.status}`);
  const out = await r.json();
  const usage = out.usageMetadata ?? {};
  const text = (out.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  let res: Record<string, unknown>;
  try { res = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    try { res = m ? JSON.parse(m[0]) : { error: "ответ не удалось разобрать" }; } catch { res = { error: "ответ не удалось разобрать" }; }
  }
  const ok = !res.error && (Array.isArray(res.items) && res.items.length > 0 || !!res.total);
  await admin.from("recognitions").insert({
    user_id: user.id, receipt_id: id, ok,
    tokens_in: usage.promptTokenCount ?? null, tokens_out: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
  });
  if (!ok) return fail(String(res.error || "позиции не найдены").slice(0, 200));

  const c = clean(res);
  const patch: Record<string, unknown> = {
    status: "done", store: c.store, total: c.total, items: c.items, error: null, updated_at: new Date().toISOString(),
  };
  if (c.date) patch.date = c.date;
  await admin.from("receipts").update(patch).eq("id", id).eq("status", "pending");
  return json({ status: "done", store: c.store, total: c.total, items: c.items.length });
});
