// Checks the one-off re-recognition script against a fake Supabase + Gemini on localhost. No network, no keys.
// Run from the repo root (Node 22.18+): node --test supabase/tests/rerecognize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { merge, select, run, type Config } from "../rerecognize.ts";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const it = (name: string, price: number) => ({ name, price, category: "Продукты", type: "Молочное" });

test("merge adds new fields and keeps the stored ones", () => {
  const stored = [{ ...it("Моё название", 85.8), category: "Дом и ремонт" }, it("Скидка", -5)];
  const fresh = [{ ...it("Молоко ×2", 85.8), product: "молоко 2,5%", brand: "Галичина", qty: 2, unit: "шт", unitPrice: 42.9 }, { ...it("Скидка", -5) }];
  const r = merge(stored, fresh);
  assert.ok("items" in r);
  assert.deepEqual(r.items[0], { name: "Моё название", price: 85.8, category: "Дом и ремонт", type: "Молочное", product: "молоко 2,5%", brand: "Галичина", qty: 2, unit: "шт", unitPrice: 42.9 });
  assert.deepEqual(r.items[1], stored[1]);
});

test("merge recomputes unitPrice from the stored price and refuses mismatches", () => {
  const r = merge([it("А", 66)], [{ ...it("А", 65.995), qty: 0.734, unit: "кг", unitPrice: 1 }]);
  assert.ok("items" in r);
  assert.equal(r.items[0].unitPrice, 89.92);
  assert.deepEqual(merge([it("А", 10)], [it("А", 10), it("Б", 1)]), { skip: "mismatch-count" });
  assert.deepEqual(merge([it("А", 10)], [it("А", 10.5)]), { skip: "mismatch-price" });
  assert.deepEqual(merge([it("А", 10)], [it("А", 10)]), { skip: "no-new-fields" });
  assert.deepEqual(merge([{ ...it("А", 10), qty: 1, unit: "шт" }], [{ ...it("А", 10), product: "а" }]), { skip: "has-fields" });
});

test("select keeps only photos already recognized by Gemini", () => {
  const r = (id: string, extra = {}) => ({ id, book_id: "b", items: [it("А", 1)], photos: ["b/p.jpg"], updated_at: "2026-10-01T00:00:00+00:00", ...extra });
  const { picked, counts } = select(
    [r("ok1"), r("nophoto", { photos: [] }), r("claude-worker"), r("bad id;"), r("done"), r("fields", { items: [{ ...it("А", 1), product: "а" }] })],
    new Set(["ok1", "nophoto", "done", "fields"]), new Set(["done"]));
  assert.deepEqual(picked.map(x => x.id), ["ok1"]);
  assert.deepEqual(counts, { "no-photos": 1, "not-recognized-by-gemini": 1, "bad-id": 1, "done-in-journal": 1, "has-fields": 1 });
});

/** A fake Supabase (REST, storage, Management API) and Gemini on one local port. */
async function fake(geminiStatuses: number[] = []) {
  const ts = "2026-10-01T10:00:00.123456+00:00";
  const books = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", owner: OWNER }, { id: "bbbbbbbb-0000-0000-0000-000000000002", owner: OTHER }];
  const receipts: Record<string, any>[] = [
    { id: "r1", book_id: books[0].id, status: "done", manual: false, photos: ["p1.jpg"], updated_at: ts, items: [it("Тайное молоко", 85.8)] },
    { id: "r2", book_id: books[0].id, status: "done", manual: false, photos: ["p2.jpg"], updated_at: ts, items: [it("А", 10), it("Б", 20)] },
    { id: "r3", book_id: books[0].id, status: "done", manual: true, photos: ["p3.jpg"], updated_at: ts, items: [it("Ручной", 5)] },
    { id: "r4", book_id: books[1].id, status: "done", manual: false, photos: ["p4.jpg"], updated_at: ts, items: [it("Чужой", 5)] },
    { id: "r5", book_id: books[0].id, status: "done", manual: false, photos: ["p5.jpg"], updated_at: ts, items: [it("Старый воркер", 5)] },
  ];
  const ok = new Set(["r1", "r2", "r3", "r4"]);
  const calls: { method: string; url: string; body: string }[] = [];
  const statuses = [...geminiStatuses];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const ch of req) body += ch;
    const url = new URL(req.url!, "http://x");
    calls.push({ method: req.method!, url: decodeURIComponent(req.url!), body });
    const send = (code: number, data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
    if (url.pathname === "/rest/v1/books") return send(200, books.filter(b => b.owner === eq("owner")).map(b => ({ id: b.id })));
    if (url.pathname === "/rest/v1/recognitions") {
      const ids = url.searchParams.get("receipt_id")!.replace(/^in\.\(|\)$/g, "").split(",").map(s => s.replace(/"/g, ""));
      return send(200, ids.filter(id => ok.has(id)).map(receipt_id => ({ receipt_id })));
    }
    if (url.pathname === "/rest/v1/receipts" && req.method === "GET") {
      return send(200, receipts.filter(r => (!eq("book_id") || r.book_id === eq("book_id")) && (!eq("id") || r.id === eq("id"))
        && (url.searchParams.get("manual") !== "is.false" || !r.manual)));
    }
    if (url.pathname === "/rest/v1/receipts" && req.method === "PATCH") {
      const r = receipts.find(x => x.id === eq("id") && x.updated_at === eq("updated_at"));
      if (!r) return send(200, []);
      Object.assign(r, JSON.parse(body));
      return send(200, [{ updated_at: r.updated_at }]);
    }
    if (url.pathname.startsWith("/storage/v1/object/photos/")) { res.writeHead(200); return res.end(Buffer.from([0xff, 0xd8])); }
    if (url.pathname.includes(":generateContent")) {
      const code = statuses.shift();
      if (code && code !== 200) return send(code, { error: "fake" });
      const n = JSON.parse(body).contents[0].parts.length;
      assert.equal(n, 2);
      const answer = { store: "Тайный магазин", total: 85.8, items: [{ ...it("Тайное молоко ×2", 85.8), product: "молоко", qty: 2, unit: "шт" }] };
      return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } });
    }
    if (url.pathname.endsWith("/database/query")) return send(201, JSON.parse(body).query.includes("returning id") ? [{ id: "x" }] : []);
    send(404, {});
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "rerec-"));
  const lines: string[] = [];
  const cfg: Config = {
    supabaseUrl: base, serviceKey: "service-key-SECRET", geminiKey: "gemini-key-SECRET", model: "m", accessToken: "pat-SECRET", projectRef: "ref",
    managementApi: base, geminiApi: base, owner: OWNER, dataDir, rpm: 600, backoffMs: 1, log: l => lines.push(l),
  };
  return { cfg, calls, receipts, lines, dataDir, close: () => { server.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("apply: owner's Gemini receipts only, items-only conditional write, backup first, no content in logs", async () => {
  const f = await fake();
  try {
    const res = await run(f.cfg, "apply", { limit: 10 });
    assert.deepEqual(res.tally, { updated: 1, "mismatch-count": 1 });
    const r1 = f.receipts.find(r => r.id === "r1")!;
    assert.deepEqual(r1.items[0], { ...it("Тайное молоко", 85.8), product: "молоко", qty: 2, unit: "шт", unitPrice: 42.9 });
    assert.notEqual(r1.updated_at, "2026-10-01T10:00:00.123456+00:00");
    for (const id of ["r2", "r3", "r4", "r5"]) assert.equal(f.receipts.find(r => r.id === id)!.updated_at, "2026-10-01T10:00:00.123456+00:00", id);
    const patches = f.calls.filter(c => c.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.match(patches[0].url, /id=eq\.r1&updated_at=eq\.2026-10-01T10:00:00\.123456\+00:00/);
    assert.deepEqual(Object.keys(JSON.parse(patches[0].body)).sort(), ["items", "updated_at"]);
    const order = f.calls.map(c => c.method === "PATCH" ? "patch" : c.body.includes("insert into private") ? "backup" : "").filter(Boolean);
    assert.deepEqual(order, ["backup", "patch"]);
    assert.ok(!f.calls.some(c => c.url.includes(OTHER) || c.url.includes("r4")), "other people's books are never read");
    const log = f.lines.join("\n");
    for (const secret of ["Тайн", "молоко", "85.8", "SECRET"]) assert.ok(!log.includes(secret), `log has ${secret}`);
    const journal = readFileSync(join(f.dataDir, "journal.jsonl"), "utf8");
    assert.ok(!journal.includes("Тайн") && !journal.includes("молоко"));
    // A second run sends nothing to Gemini: both receipts are final in the journal.
    const again = await run(f.cfg, "apply", { limit: 10 });
    assert.deepEqual(again.tally, {});
  } finally { f.close(); }
});

test("dry-run writes nothing to the database and leaves before/after for the owner", async () => {
  const f = await fake();
  try {
    const res = await run(f.cfg, "dry-run", { limit: 2 });
    assert.deepEqual(res.tally, { "would-update": 1, "mismatch-count": 1 });
    assert.ok(!f.calls.some(c => c.method === "PATCH" || c.url.includes("/database/query")));
    assert.equal(JSON.parse(readFileSync(join(f.dataDir, "dry-run.json"), "utf8")).length, 2);
    assert.ok(!existsSync(join(f.dataDir, "journal.jsonl")));
  } finally { f.close(); }
});

test("three 429s in a row from Gemini stop the run without writing", async () => {
  const f = await fake([429, 429, 429]);
  try {
    const res = await run(f.cfg, "apply", { limit: 10 });
    assert.deepEqual(res.tally, {});
    assert.ok(f.lines.some(l => l.includes("stop: Gemini answered 429")));
    assert.ok(!f.calls.some(c => c.method === "PATCH"));
  } finally { f.close(); }
});

test("an edit made during the run is not overwritten", async () => {
  const f = await fake();
  try {
    f.receipts.forEach(r => { if (r.id === "r1") r.updated_at = "2026-10-01T10:00:00.123456+00:00"; });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes(":generateContent")) f.receipts.find(r => r.id === "r1")!.updated_at = "2026-11-09T12:00:00+00:00";
      return origFetch(input, init);
    };
    try {
      const res = await run(f.cfg, "apply", { limit: 1 });
      assert.deepEqual(res.tally, { changed: 1 });
      assert.equal(f.receipts.find(r => r.id === "r1")!.items[0].product, undefined);
    } finally { globalThis.fetch = origFetch; }
  } finally { f.close(); }
});

test("apply needs --limit, rollback and cleanup need --yes", async () => {
  const f = await fake();
  try {
    await assert.rejects(run(f.cfg, "apply", {}), /--limit/);
    await assert.rejects(run(f.cfg, "rollback", {}), /--yes/);
    await assert.rejects(run(f.cfg, "cleanup", {}), /--yes/);
  } finally { f.close(); }
});
