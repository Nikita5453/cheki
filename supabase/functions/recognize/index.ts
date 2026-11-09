// Распознавание чека через Gemini. Сайт вызывает функцию сразу после загрузки фото: { id: "<id чека>" }.
// Ключ Gemini хранится в секретах проекта (GEMINI_API_KEY) и в браузер не попадает.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
// The prompt, the request settings and the checks on Gemini's answer (item format: see clean() there).
import { clean, geminiBody, prompt } from "./receipt.ts";

const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite";
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "20");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

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
    body: JSON.stringify(geminiBody(parts)),
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
