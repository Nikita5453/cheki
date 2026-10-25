"""One-off move of the old GitHub data (data/data.json + data/photos) into Supabase.

  python supabase/migrate.py            — list signed-up users
  python supabase/migrate.py EMAIL      — create books «Общие», «Никита», «Люда» for that user and copy receipts and photos

Safe to run twice: books are reused by name, receipts are upserted by id, photos overwrite.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8")

env = {}
for line in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        if v.strip() or k.strip() not in env:
            env[k.strip()] = v.strip()
URL, KEY = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_KEY"]

BOOKS = [("common", "Общие", 6200), ("nikita", "Никита", None), ("lyuda", "Люда", None)]


def call(method, path, body=None, headers=None, data=None):
    h = {"apikey": KEY, "Authorization": "Bearer " + KEY, **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(URL + path, method=method, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


users = call("GET", "/auth/v1/admin/users?per_page=100")["users"]
if len(sys.argv) < 2:
    print("users:", [u["email"] for u in users])
    sys.exit()
user = next((u for u in users if u["email"].lower() == sys.argv[1].lower()), None)
if not user:
    sys.exit(f"No user {sys.argv[1]}; signed up: {[u['email'] for u in users]}")
uid = user["id"]

old = json.loads((ROOT / "data" / "data.json").read_text(encoding="utf-8"))
start = (old.get("budget") or {}).get("startDate") or "2026-09-23"

existing = call("GET", f"/rest/v1/books?owner=eq.{uid}&select=id,name")
book_ids = {}
for key, name, budget in BOOKS:
    found = next((b for b in existing if b["name"] == name), None)
    if not found:
        found = call("POST", "/rest/v1/books", {"name": name, "owner": uid, "monthly_budget": budget, "start_date": start},
                     headers={"Prefer": "return=representation"})[0]
        print("created book", name)
    book_ids[key] = found["id"]

rows, uploaded = [], 0
for r in old["receipts"]:
    photos = []
    for p in r.get("photos") or []:
        src = ROOT / "data" / p
        if not src.exists():
            continue
        dest = f"{uid}/{Path(p).name}"
        call("POST", "/storage/v1/object/photos/" + urllib.parse.quote(dest), data=src.read_bytes(),
             headers={"Content-Type": "image/jpeg", "x-upsert": "true"})
        photos.append(dest)
        uploaded += 1
    rows.append({
        "id": r["id"], "book_id": book_ids.get(r.get("wallet") or "common", book_ids["common"]), "author": uid,
        "status": r.get("status") or "done", "date": r.get("date"), "store": r.get("store") or "",
        "total": r.get("total") or 0, "items": r.get("items") or [], "photos": photos, "manual": bool(r.get("manual")),
        "error": r.get("error"), "created_at": r.get("createdAt") or None, "updated_at": r.get("updatedAt") or None,
    })
for row in rows:
    for k in ("created_at", "updated_at"):
        if not row[k]:
            row.pop(k)
if rows:
    call("POST", "/rest/v1/receipts?on_conflict=id", rows,
         headers={"Prefer": "resolution=merge-duplicates,return=minimal"})

counts = {name: sum(1 for x in rows if x["book_id"] == book_ids[key]) for key, name, _ in BOOKS}
totals = {name: round(sum(float(x["total"]) for x in rows if x["book_id"] == book_ids[key] and x["status"] == "done"), 2)
          for key, name, _ in BOOKS}
print(f"receipts: {len(rows)} {counts}; totals: {totals}; photos uploaded: {uploaded}; start date {start}")
