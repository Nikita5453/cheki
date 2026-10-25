"""Supabase setup helper for «Бюджет по чекам» (Management API, token from ../.env).

  python supabase/admin.py info          — find the «cheki» project, save its URL and keys into .env (not printed)
  python supabase/admin.py sql FILE      — run a SQL file on the project
  python supabase/admin.py auth K=V ...  — update auth settings (values may be @ENV_NAME to read from .env)
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
API = "https://api.supabase.com/v1"

sys.stdout.reconfigure(encoding="utf-8")


def read_env():
    env = {}
    for line in ENV.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if v or k not in env:
                env[k] = v
    return env


def write_env(updates):
    lines = ENV.read_text(encoding="utf-8-sig").splitlines()
    seen = set()
    out = []
    for line in lines:
        k = line.split("=", 1)[0].strip() if "=" in line else None
        if k in updates:
            if k in seen:
                continue
            out.append(f"{k}={updates[k]}")
            seen.add(k)
        else:
            out.append(line)
    for k, v in updates.items():
        if k not in seen:
            out.append(f"{k}={v}")
    ENV.write_text("\n".join(out) + "\n", encoding="utf-8")


def call(method, path, body=None):
    token = read_env().get("SUPABASE_ACCESS_TOKEN", "")
    if not token:
        sys.exit("SUPABASE_ACCESS_TOKEN is empty in .env")
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                                          "User-Agent": "cheki-admin"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on {method} {path}: {e.read().decode()[:600]}")


def project():
    env = read_env()
    if env.get("SUPABASE_REF"):
        return env["SUPABASE_REF"]
    projects = call("GET", "/projects")
    match = [p for p in projects if p.get("name", "").lower() == "cheki"] or projects
    if not match:
        sys.exit("No Supabase projects found for this token")
    return match[0]["ref"]


def info():
    projects = call("GET", "/projects")
    print("projects:", [(p["name"], p["ref"], p.get("status"), p.get("region")) for p in projects])
    match = [p for p in projects if p.get("name", "").lower() == "cheki"] or projects
    ref = match[0]["ref"]
    keys = call("GET", f"/projects/{ref}/api-keys?reveal=true")
    by = {k.get("name"): k for k in keys}
    anon = (by.get("anon") or by.get("default") or next((k for k in keys if k.get("type") == "publishable"), {})).get("api_key", "")
    service = (by.get("service_role") or next((k for k in keys if k.get("type") == "secret"), {})).get("api_key", "")
    write_env({"SUPABASE_REF": ref, "SUPABASE_URL": f"https://{ref}.supabase.co",
               "SUPABASE_ANON_KEY": anon, "SUPABASE_SERVICE_KEY": service})
    print(f"using project {match[0]['name']} ({ref}); key names: {[k.get('name') for k in keys]}")
    print("saved to .env: SUPABASE_REF, SUPABASE_URL, SUPABASE_ANON_KEY" + (" (ok)" if anon else " (MISSING)")
          + ", SUPABASE_SERVICE_KEY" + (" (ok)" if service else " (MISSING)"))


def sql(file):
    q = Path(file).read_text(encoding="utf-8")
    res = call("POST", f"/projects/{project()}/database/query", {"query": q})
    print(json.dumps(res, ensure_ascii=False)[:2000])


def auth(pairs):
    env = read_env()
    body = {}
    for p in pairs:
        k, v = p.split("=", 1)
        if v.startswith("@"):
            v = env.get(v[1:], "")
        body[k] = {"true": True, "false": False}.get(v, v)
    call("PATCH", f"/projects/{project()}/config/auth", body)
    cfg = call("GET", f"/projects/{project()}/config/auth")
    print({k: cfg.get(k) for k in body if "secret" not in k})


def deploy(name):
    """Upload supabase/functions/<name>/index.ts as an Edge Function (multipart: metadata + file)."""
    src = (ROOT / "supabase" / "functions" / name / "index.ts").read_bytes()
    boundary = "----cheki" + str(abs(hash(src)))
    meta = json.dumps({"name": name, "entrypoint_path": "index.ts", "verify_jwt": True}).encode()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n".encode()
            + meta + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"index.ts\"\r\n"
                     f"Content-Type: application/typescript\r\n\r\n".encode()
            + src + f"\r\n--{boundary}--\r\n".encode())
    token = read_env().get("SUPABASE_ACCESS_TOKEN", "")
    req = urllib.request.Request(f"{API}/projects/{project()}/functions/deploy?slug={name}", method="POST", data=body,
                                 headers={"Authorization": "Bearer " + token, "User-Agent": "cheki-admin",
                                          "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on deploy: {e.read().decode()[:600]}")
    print({k: res.get(k) for k in ("slug", "status", "version", "verify_jwt")})


def secret(pairs):
    env = read_env()
    body = []
    for p in pairs:
        k, v = p.split("=", 1)
        body.append({"name": k, "value": env.get(v[1:], "") if v.startswith("@") else v})
    call("POST", f"/projects/{project()}/secrets", body)
    names = [s["name"] for s in call("GET", f"/projects/{project()}/secrets")]
    print("secrets now:", names)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "info"
    {"info": lambda: info(), "sql": lambda: sql(sys.argv[2]), "auth": lambda: auth(sys.argv[2:]),
     "deploy": lambda: deploy(sys.argv[2]), "secret": lambda: secret(sys.argv[2:])}[cmd]()
