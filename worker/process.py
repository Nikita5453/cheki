"""Распознавание чеков из очереди через Claude Code CLI (лимиты подписки Claude).

Берёт из Supabase чеки со статусом "pending" (из всех сборок), скачивает их фото,
отдаёт `claude -p` и записывает позиции и категории обратно в базу.
Ключ SUPABASE_SERVICE_KEY лежит в ../.env и никуда, кроме этого компьютера, не попадает.

Запуск:  python worker/process.py          — работать постоянно, проверяя очередь
         python worker/process.py --once   — обработать очередь один раз и выйти
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_FILE = HERE.parent / ".env"
INTERVAL = int(os.environ.get("CHEKI_INTERVAL", "30"))       # секунд между проверками очереди
MODEL = os.environ.get("CHEKI_MODEL", "sonnet")               # sonnet читает чеки надёжнее, haiku экономнее
LOG = HERE / "worker.log"

EXP = ["Продукты", "Хозтовары и бытовая химия", "Кафе и доставка", "Аптека и здоровье", "Транспорт и топливо",
       "Одежда и обувь", "Дом и ремонт", "Связь и подписки", "Дети", "Животные", "Красота и уход", "Развлечения", "Другое"]
FOOD = ["Молочное", "Яйца", "Мясо и птица", "Рыба и морепродукты", "Овощи", "Фрукты и ягоды", "Хлеб и выпечка",
        "Крупы, макароны, мука", "Бакалея и консервы", "Масло, соусы, специи", "Сладости и снеки", "Чай и кофе", "Напитки",
        "Алкоголь", "Готовая еда", "Замороженное"]


class ClaudeUnavailable(Exception):
    """CLI не может работать вообще (не вошли в аккаунт, лимит, нет сети) — чек не трогаем, ждём."""


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line, flush=True)
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def find_claude():
    found = shutil.which("claude")
    if found:
        return found
    for p in (Path.home() / ".local/bin/claude.exe", Path.home() / ".local/bin/claude"):
        if p.exists():
            return str(p)
    sys.exit("Не найден Claude Code CLI. Установите его: irm https://claude.ai/install.ps1 | iex")


def read_env():
    env = {}
    for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            if v.strip() or k.strip() not in env:
                env[k.strip()] = v.strip()
    return env


ENV = read_env()
SB_URL = ENV.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = ENV.get("SUPABASE_SERVICE_KEY", "")


def sb(method, path, body=None, headers=None, raw=False):
    req = urllib.request.Request(
        SB_URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
        return data if raw else (json.loads(data) if data else None)


def pending():
    return sb("GET", "/rest/v1/receipts?status=eq.pending&select=id,photos,book_id&order=created_at")


def download(path, folder):
    data = sb("GET", "/storage/v1/object/photos/" + urllib.parse.quote(path), raw=True)
    dest = Path(folder) / path.replace("/", "_")
    dest.write_bytes(data)
    return str(dest)


def update_if_pending(rid, patch):
    """Записывает результат, только если чек всё ещё ждёт: его могли удалить или заполнить вручную."""
    rows = sb("PATCH", f"/rest/v1/receipts?id=eq.{urllib.parse.quote(rid)}&status=eq.pending", patch,
              headers={"Prefer": "return=representation"})
    return bool(rows)


def prompt_for(photos):
    files = "\n".join(f"- {p}" for p in photos)
    return f"""Перед тобой фото кассового чека (файлы ниже — прочитай каждый инструментом Read). Если фото несколько, это части одного длинного чека по порядку.
{files}

Верни только JSON, без пояснений и без markdown, такого вида:
{{"store": "Название магазина", "date": "YYYY-MM-DD", "total": 1234.5, "items": [{{"name": "Молоко 2,5% 0,9 л", "price": 42.9, "category": "Продукты", "type": "Молочное"}}]}}

Правила:
- Валюта — гривны. Чек может быть на украинском или русском; name пиши по-русски.
- store: короткое название магазина или заведения, как его называют люди (без ТОВ/ФОП, адреса и кодов).
- date: дата покупки из чека в формате YYYY-MM-DD; если не читается, null. Сегодня {date.today().isoformat()}.
- items: каждая строка товара или услуги. price — итоговая сумма по строке с учётом количества и скидки на строку, числом. name — понятное короткое название без артикулов и кодов; если количество больше одного, допиши «×N».
- category: строго одно значение из списка: {"; ".join(EXP)}.
- type: вид продукта. Для еды и напитков строго одно значение из списка: {"; ".join(FOOD)}. Для остального — короткий общий вид в 1–3 слова, например «Моющие средства», «Лекарства», «Бензин», «Корм».
- Если в чеке есть общая скидка, оплата бонусами или округление, добавь отдельную строку с отрицательной price (name «Скидка»), category и type как у большей части покупок, чтобы сумма всех price равнялась total.
- total: сумма к оплате по чеку, числом.
- Если на фото не чек или его невозможно прочитать, верни {{"error": "коротко, что не так"}}."""


def parse_json(text):
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def ask_claude(claude, photos, workdir):
    cmd = [claude, "-p", "--output-format", "json", "--model", MODEL, "--allowedTools", "Read", "--max-turns", "8"]
    try:
        r = subprocess.run(cmd, input=prompt_for(photos), cwd=workdir, capture_output=True,
                           text=True, encoding="utf-8", timeout=600)
    except subprocess.TimeoutExpired:
        raise ClaudeUnavailable("Claude не ответил за 10 минут")
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise ClaudeUnavailable((r.stderr or r.stdout or "пустой ответ").strip()[:300])
    result = str(out.get("result") or "")
    if out.get("is_error"):
        raise ClaudeUnavailable(result[:300] or out.get("subtype", "ошибка CLI"))
    return parse_json(result)


def num(v):
    try:
        return round(float(str(v).replace(",", ".").replace(" ", "")), 2)
    except (TypeError, ValueError):
        return 0.0


def clean(res):
    items = []
    for it in res.get("items") or []:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()
        price = num(it.get("price"))
        if not name and not price:
            continue
        cat = it.get("category") if it.get("category") in EXP else "Другое"
        items.append({"name": name or "Позиция", "price": price, "category": cat, "type": str(it.get("type") or "").strip()})
    total = num(res.get("total")) if res.get("total") is not None else round(sum(i["price"] for i in items), 2)
    d = str(res.get("date") or "")
    return {
        "store": str(res.get("store") or "").strip(),
        "date": d if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) else None,
        "total": total,
        "items": items,
    }


def process_one(claude, rec):
    with tempfile.TemporaryDirectory(prefix="cheki-") as tmp:
        photos = []
        for p in rec.get("photos") or []:
            try:
                photos.append(download(p, tmp))
            except urllib.error.HTTPError as e:
                if e.code not in (400, 404):
                    raise
        if not photos:
            outcome = {"error": "фото чека не найдено"}
        else:
            try:
                res = ask_claude(claude, photos, tmp)
                outcome = res if isinstance(res, dict) else {"error": "непонятный ответ"}
            except (json.JSONDecodeError, ValueError):
                outcome = {"error": "ответ не удалось разобрать"}

    now = datetime.now().astimezone().isoformat(timespec="seconds")
    if outcome.get("error") or not (outcome.get("items") or outcome.get("total")):
        err = str(outcome.get("error") or "позиции не найдены")[:200]
        if update_if_pending(rec["id"], {"status": "error", "error": err, "updated_at": now}):
            log(f"Чек {rec['id']}: не распознан — {err}")
        return
    c = clean(outcome)
    patch = {"status": "done", "store": c["store"], "total": c["total"], "items": c["items"], "error": None, "updated_at": now}
    if c["date"]:
        patch["date"] = c["date"]
    if update_if_pending(rec["id"], patch):
        log(f"Чек {rec['id']}: {c['store'] or 'без названия'}, {len(c['items'])} поз., {c['total']} грн")


def run_once(claude):
    queue = pending()
    for rec in queue:
        log(f"Распознаю чек {rec['id']} ({len(rec.get('photos') or [])} фото)…")
        process_one(claude, rec)
    return len(queue)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass
    if not SB_URL or not SB_KEY:
        sys.exit("В .env нет SUPABASE_URL или SUPABASE_SERVICE_KEY")
    once = "--once" in sys.argv
    claude = find_claude()
    log(f"Готов. База: {SB_URL}. Модель: {MODEL}. " + ("Один проход." if once else f"Проверяю очередь каждые {INTERVAL} с. Окно можно свернуть."))
    while True:
        wait = INTERVAL
        try:
            run_once(claude)
        except ClaudeUnavailable as e:
            log(f"Claude сейчас недоступен: {e}. Повторю через 5 минут.")
            if "login" in str(e).lower():
                log("Похоже, CLI не вошёл в аккаунт. Выполните в терминале: claude auth login")
            wait = 300
        except Exception as e:                # сеть, Supabase — подождём и попробуем снова
            log(f"Ошибка: {e}")
            wait = 60
        if once:
            break
        time.sleep(wait)


if __name__ == "__main__":
    main()
