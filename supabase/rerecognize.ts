// One-off re-recognition of old receipts for CHK-11: adds product, brand, qty, unit and unitPrice to items that the
// receipt photo already went to Gemini for. Uses the same prompt, request settings and checks as the `recognize`
// Edge Function (./functions/recognize/receipt.ts), so it stores exactly what the function would store.
//
//   node supabase/rerecognize.ts plan     [--owner UUID]                  counts only, no Gemini, no writes
//   node supabase/rerecognize.ts dry-run  [--owner UUID] [--limit 2] [--ids a,b]
//                                          asks Gemini, writes nothing to the database; before/after goes to
//                                          data/rerecognize/dry-run.json for the owner to look at
//   node supabase/rerecognize.ts apply    --limit N [--owner UUID] [--ids a,b] [--rpm 4]
//                                          backs up and updates `items` of up to N receipts
//   node supabase/rerecognize.ts rollback --yes                           restores items from the backup
//   node supabase/rerecognize.ts cleanup  --yes                           drops the backup table and data/rerecognize
//
// Run from the main checkout (Node 22.18+ runs .ts as is). Keys come only from .env next to this folder:
// SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY, and for apply/rollback/cleanup SUPABASE_ACCESS_TOKEN and
// SUPABASE_REF. GEMINI_MODEL and CHEKI_OWNER_ID (the owner's user id) are optional there. Nothing secret, no store
// names, items or sums are printed: the console and the journal get receipt ids, statuses and counts only.
//
// Which receipts (Security, issue #14): in a book whose books.owner is the owner; status 'done'; manual = false;
// has photos; has a recognitions row with ok = true (the photo already went to Gemini once); no item has the new
// fields yet. The service key bypasses RLS, so every one of these conditions is checked here explicitly.
//
// What is written: only `items` (and updated_at), only when Gemini returns the same number of lines with the same
// prices (±0.01). Existing name/price/category/type stay as they are (they may be the owner's edits); the new fields
// are added from Gemini and unitPrice is recomputed from the stored price. The write is conditional on updated_at,
// so an edit made meanwhile is never overwritten. Before each write the row's items go to
// private.receipts_items_backup_chk11 (not exposed through the API; rows vanish with their receipt).

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clean, geminiBody, prompt } from "./functions/recognize/receipt.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NEW = ["product", "brand", "qty", "unit", "unitPrice"];
const BACKUP = "private.receipts_items_backup_chk11";
const DEFAULT_MODEL = "gemini-3.5-flash-lite"; // same default as the function; set GEMINI_MODEL in .env if the function's secret differs

type Item = Record<string, unknown>;
type Receipt = { id: string; book_id: string; items: Item[]; photos: string[]; updated_at: string };
export type Config = {
  supabaseUrl: string; serviceKey: string; geminiKey: string; model: string;
  accessToken?: string; projectRef?: string; managementApi?: string; geminiApi?: string;
  owner: string; dataDir: string; rpm: number; backoffMs: number; log: (line: string) => void;
};

// ---------- pure parts (tested in supabase/tests/rerecognize.test.ts) ----------

const r2 = (n: number) => Math.round(n * 100) / 100;
export const hasNewFields = (items: Item[]) => items.some(it => it && NEW.some(k => k in it));
const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const SAFE_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Adds the new fields from Gemini's cleaned lines to the stored ones, or says why it cannot. */
export function merge(stored: Item[], fresh: Item[]): { items: Item[] } | { skip: string } {
  if (hasNewFields(stored)) return { skip: "has-fields" };
  if (stored.length !== fresh.length) return { skip: "mismatch-count" };
  for (let i = 0; i < stored.length; i++) {
    if (Math.abs(Number(stored[i].price) - Number(fresh[i].price)) > 0.01) return { skip: "mismatch-price" };
  }
  let added = 0;
  const items = stored.map((old, i) => {
    const price = Number(old.price);
    const out: Item = { ...old };
    if (!(price > 0)) return out;
    const f = fresh[i];
    if (typeof f.product === "string") { out.product = f.product; added++; }
    if (typeof f.brand === "string") { out.brand = f.brand; added++; }
    if (typeof f.qty === "number" && typeof f.unit === "string") {
      out.qty = f.qty; out.unit = f.unit; out.unitPrice = r2(price / f.qty); added++;
    }
    return out;
  });
  return added ? { items } : { skip: "no-new-fields" };
}

/** The receipts the rules allow, and how many were left out for each reason. */
export function select(receipts: Receipt[], okIds: Set<string>, journalDone: Set<string>) {
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const picked = receipts.filter(r => {
    if (!SAFE_ID.test(r.id)) return bump("bad-id"), false;
    if (!r.photos?.length) return bump("no-photos"), false;
    if (!okIds.has(r.id)) return bump("not-recognized-by-gemini"), false;
    if (hasNewFields(r.items ?? [])) return bump("has-fields"), false;
    if (journalDone.has(r.id)) return bump("done-in-journal"), false;
    return true;
  });
  return { picked, counts };
}

// ---------- I/O ----------

function readEnv(): Record<string, string> {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) throw new Error("no .env next to supabase/ — run this from the main checkout");
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !line.trimStart().startsWith("#") && (m[2].trim() || !(m[1] in env))) env[m[1]] = m[2].trim();
  }
  return env;
}

class HttpError extends Error {
  status: number;
  constructor(what: string, status: number) { super(`${what}: HTTP ${status}`); this.status = status; }
}

function api(cfg: Config) {
  const sbHeaders = { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` };
  const rest = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, { ...init, headers: { ...sbHeaders, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    if (!r.ok) throw new HttpError(`database ${path.split("?")[0]}`, r.status);
    return r.json();
  };
  const restAll = async (path: string) => {
    const out: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const page = await rest(path, { headers: { Range: `${from}-${from + 999}` } }) as unknown[];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  };
  const photo = async (path: string) => {
    const r = await fetch(`${cfg.supabaseUrl}/storage/v1/object/photos/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: sbHeaders });
    if (r.status === 400 || r.status === 404) return null;
    if (!r.ok) throw new HttpError("storage", r.status);
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  };
  const sql = async (query: string) => {
    if (!cfg.accessToken || !cfg.projectRef) throw new Error("SUPABASE_ACCESS_TOKEN and SUPABASE_REF are needed in .env for this step");
    const r = await fetch(`${cfg.managementApi ?? "https://api.supabase.com"}/v1/projects/${cfg.projectRef}/database/query`, {
      method: "POST", headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json", "User-Agent": "cheki-admin" },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new HttpError("management api", r.status);
    return await r.json() as Record<string, unknown>[];
  };
  const gemini = async (parts: unknown[]) => {
    const r = await fetch(`${cfg.geminiApi ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${cfg.model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.geminiKey },
      body: JSON.stringify(geminiBody(parts)),
    });
    if (!r.ok) throw new HttpError("gemini", r.status);
    return await r.json() as Record<string, any>;
  };
  return { rest, restAll, photo, sql, gemini };
}

const inList = (ids: string[]) => `(${ids.map(id => `"${id}"`).join(",")})`;
const lit = (s: string, re: RegExp) => { if (!re.test(s)) throw new Error("unsafe value for SQL"); return `'${s}'`; };

async function candidates(cfg: Config, A: ReturnType<typeof api>, onlyIds: string[] | null, journalDone: Set<string>) {
  const books = await A.restAll(`books?owner=eq.${cfg.owner}&select=id`) as { id: string }[];
  const receipts: Receipt[] = [];
  for (const b of books) {
    receipts.push(...await A.restAll(`receipts?book_id=eq.${b.id}&status=eq.done&manual=is.false&select=id,book_id,items,photos,updated_at&order=created_at.asc`) as Receipt[]);
  }
  const scoped = onlyIds ? receipts.filter(r => onlyIds.includes(r.id)) : receipts;
  const okIds = new Set<string>();
  const ids = scoped.map(r => r.id).filter(id => SAFE_ID.test(id));
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await A.restAll(`recognitions?ok=is.true&select=receipt_id&receipt_id=in.${inList(ids.slice(i, i + 100))}`) as { receipt_id: string }[];
    rows.forEach(r => okIds.add(r.receipt_id));
  }
  return { books: books.length, ...select(scoped, okIds, journalDone) };
}

function readJournal(cfg: Config) {
  const file = join(cfg.dataDir, "journal.jsonl");
  const done = new Set<string>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (FINAL.has(e.status)) done.add(e.id); else done.delete(e.id);
    }
  }
  return done;
}
// Statuses after which the receipt is not sent to Gemini again; "changed" and "error" are retried on the next run.
const FINAL = new Set(["updated", "no-new-fields", "mismatch-count", "mismatch-price", "gemini-empty", "photo-missing", "has-fields"]);

const SETUP_SQL = `create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists ${BACKUP} (
  id text primary key references public.receipts(id) on delete cascade,
  items jsonb not null,
  updated_at timestamptz not null,
  written_updated_at timestamptz,
  backed_up_at timestamptz not null default now()
);
alter table ${BACKUP} enable row level security;
revoke all on ${BACKUP} from public, anon, authenticated;`;

/** One receipt: fresh read → Gemini → merge → (apply) backup → conditional write. Returns its status. */
async function one(cfg: Config, A: ReturnType<typeof api>, id: string, apply: boolean, report: unknown[]) {
  const [rec] = await A.rest(`receipts?id=eq.${encodeURIComponent(id)}&select=id,book_id,items,photos,updated_at,status,manual`) as (Receipt & { status: string; manual: boolean })[];
  if (!rec || rec.status !== "done" || rec.manual) return { status: "changed" };
  if (hasNewFields(rec.items ?? [])) return { status: "has-fields" };
  const parts: unknown[] = [{ text: prompt(new Date().toISOString().slice(0, 10)) }];
  for (const p of (rec.photos ?? []).slice(0, 4)) {
    const data = await A.photo(p);
    if (data) parts.push({ inline_data: { mime_type: "image/jpeg", data } });
  }
  if (parts.length < 2) return { status: "photo-missing" };

  const out = await A.gemini(parts);
  const usage = out.usageMetadata ?? {};
  const tokens = `${usage.promptTokenCount ?? "?"}/${(usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)}`;
  const text = (out.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  let res: Record<string, unknown>;
  try { res = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    try { res = m ? JSON.parse(m[0]) : { error: "unparsed" }; } catch { res = { error: "unparsed" }; }
  }
  const ok = !res.error && (Array.isArray(res.items) && res.items.length > 0 || !!res.total);
  if (!ok) return { status: "gemini-empty", tokens };
  const fresh = clean(res).items as Item[];
  const merged = merge(rec.items ?? [], fresh);
  if (!apply) report.push({ id, book_id: rec.book_id, status: "skip" in merged ? merged.skip : "would-update", before: rec.items, after: "items" in merged ? merged.items : null, gemini: fresh });
  if ("skip" in merged) return { status: merged.skip, tokens, items: (rec.items ?? []).length };
  if (!apply) return { status: "would-update", tokens, items: (rec.items ?? []).length };

  const backedUp = await A.sql(`with src as (select id, items, updated_at from public.receipts where id = ${lit(id, SAFE_ID)} and updated_at = ${lit(rec.updated_at, SAFE_TS)})
insert into ${BACKUP} (id, items, updated_at) select id, items, updated_at from src
on conflict (id) do update set items = excluded.items, updated_at = excluded.updated_at, backed_up_at = now()
  where ${BACKUP}.written_updated_at is null
returning id;`);
  if (!backedUp.length) return { status: "changed", tokens };
  const written = await A.rest(`receipts?id=eq.${encodeURIComponent(id)}&updated_at=eq.${encodeURIComponent(rec.updated_at)}&select=updated_at`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ items: merged.items, updated_at: new Date().toISOString() }),
  }) as { updated_at: string }[];
  if (!written.length) return { status: "changed", tokens };
  await A.sql(`update ${BACKUP} set written_updated_at = ${lit(written[0].updated_at, SAFE_TS)} where id = ${lit(id, SAFE_ID)};`);
  return { status: "updated", tokens, items: (rec.items ?? []).length, written: written[0].updated_at };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run(cfg: Config, mode: string, opts: { limit?: number; ids?: string[] | null; yes?: boolean }) {
  const A = api(cfg);
  mkdirSync(cfg.dataDir, { recursive: true });
  const journalFile = join(cfg.dataDir, "journal.jsonl");

  if (mode === "rollback" || mode === "cleanup") {
    if (!opts.yes) throw new Error(`${mode} changes the database: add --yes`);
    if (mode === "rollback") {
      const restored = await A.sql(`with restored as (
  update public.receipts r set items = b.items, updated_at = now()
  from ${BACKUP} b where r.id = b.id and b.written_updated_at is not null and r.updated_at = b.written_updated_at
  returning r.id)
update ${BACKUP} b set written_updated_at = null from restored where b.id = restored.id returning b.id;`);
      const [left] = await A.sql(`select count(*)::int as n from ${BACKUP} where written_updated_at is not null;`);
      if (existsSync(journalFile)) writeFileSync(join(cfg.dataDir, `journal.rolled-back-${Date.now()}.jsonl`), readFileSync(journalFile)), rmSync(journalFile);
      cfg.log(`rollback: restored ${restored.length}; not restored because edited after the run: ${left?.n ?? "?"}`);
      return { restored: restored.length, left: left?.n };
    }
    await A.sql(`drop table if exists ${BACKUP};
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'private')
     and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private') then
    drop schema private;
  end if;
end $$;`);
    rmSync(cfg.dataDir, { recursive: true, force: true });
    cfg.log("cleanup: backup table dropped, data/rerecognize deleted");
    return {};
  }

  const journalDone = readJournal(cfg);
  const c = await candidates(cfg, A, opts.ids ?? null, journalDone);
  cfg.log(`owner's books: ${c.books}; receipts to do: ${c.picked.length}; left out: ${JSON.stringify(c.counts)}`);
  const perBook: Record<string, number> = {};
  c.picked.forEach(r => { perBook[r.book_id.slice(0, 8)] = (perBook[r.book_id.slice(0, 8)] ?? 0) + 1; });
  cfg.log(`per book (id prefix: receipts): ${JSON.stringify(perBook)}`);
  if (mode === "plan") return { picked: c.picked.length, counts: c.counts, perBook };

  const apply = mode === "apply";
  if (apply && !opts.limit) throw new Error("apply needs --limit N");
  const batch = c.picked.slice(0, opts.limit ?? 2);
  if (apply) await A.sql(SETUP_SQL);
  const report: unknown[] = [];
  const tally: Record<string, number> = {};
  let in429 = 0, errors = 0, last = 0;
  for (let i = 0; i < batch.length; i++) {
    const id = batch[i].id;
    const wait = last + 60000 / cfg.rpm - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let r: { status: string; tokens?: string; items?: number; written?: string };
    try {
      r = await one(cfg, A, id, apply, report);
      in429 = 0; errors = 0;
    } catch (e) {
      if (e instanceof HttpError && e.status === 429 && e.message.startsWith("gemini")) {
        if (++in429 >= 3) { cfg.log(`${id}  stop: Gemini answered 429 three times in a row (quota); run again later`); break; }
        cfg.log(`${id}  Gemini 429, waiting ${Math.round(cfg.backoffMs / 1000)} s`);
        await sleep(cfg.backoffMs); i--; continue;
      }
      r = { status: "error" };
      errors++;
      cfg.log(`${id}  error: ${e instanceof Error ? e.message : "unknown"}`);
    }
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    cfg.log(`${id}  ${r.status}${r.items != null ? `  items=${r.items}` : ""}${r.tokens ? `  tokens=${r.tokens}` : ""}`);
    if (apply) appendFileSync(journalFile, JSON.stringify({ id, status: r.status, written: r.written ?? null, at: new Date().toISOString() }) + "\n");
    if (errors >= 5) { cfg.log("stop: five errors in a row"); break; }
  }
  if (!apply) writeFileSync(join(cfg.dataDir, "dry-run.json"), JSON.stringify(report, null, 2));
  cfg.log(`done: ${JSON.stringify(tally)}; left after this run: ${c.picked.length - batch.length}` + (apply ? "" : "; before/after for the owner: data/rerecognize/dry-run.json"));
  return { tally, remaining: c.picked.length - batch.length };
}

function arg(args: string[], name: string) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (!["plan", "dry-run", "apply", "rollback", "cleanup"].includes(mode ?? "")) {
    console.log("usage: node supabase/rerecognize.ts plan|dry-run|apply|rollback|cleanup [--owner UUID] [--limit N] [--ids a,b] [--rpm 4] [--yes]");
    process.exit(2);
  }
  try {
    const env = readEnv();
    const owner = arg(args, "--owner") ?? env.CHEKI_OWNER_ID ?? "";
    if (!["rollback", "cleanup"].includes(mode) && !UUID.test(owner)) throw new Error("the owner's user id is needed: --owner UUID or CHEKI_OWNER_ID in .env");
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY || (["dry-run", "apply"].includes(mode) && !env.GEMINI_API_KEY)) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_KEY and GEMINI_API_KEY are needed in .env");
    const ids = arg(args, "--ids")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
    const limit = arg(args, "--limit") ? Number(arg(args, "--limit")) : undefined;
    if (limit != null && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit must be a positive whole number");
    const rpm = Number(arg(args, "--rpm") ?? 4);
    if (!(rpm > 0 && rpm <= 10)) throw new Error("--rpm must be between 1 and 10");
    await run({
      supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ""), serviceKey: env.SUPABASE_SERVICE_KEY, geminiKey: env.GEMINI_API_KEY ?? "",
      model: env.GEMINI_MODEL || DEFAULT_MODEL, accessToken: env.SUPABASE_ACCESS_TOKEN, projectRef: env.SUPABASE_REF,
      owner, dataDir: join(ROOT, "data", "rerecognize"), rpm, backoffMs: 60000,
      log: line => console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`),
    }, mode, { limit, ids, yes: args.includes("--yes") });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : "unknown"}`);
    process.exit(1);
  }
}
