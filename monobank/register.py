"""Заявка на доступ к API Монобанка для провайдеров услуг.

    python monobank/register.py check     — собрать и подписать заявку, показать её, ничего не отправляя
    python monobank/register.py send      — отправить заявку в банк
    python monobank/register.py status    — узнать статус заявки (New | Declined | Approved) и keyId

Данные заявки: monobank/keys/application.json (в git не попадает).
Ключи: monobank/keys/priv.pem и pub.pem (secp256k1, в git не попадают).
Документация: https://api.monobank.ua/docs/corporate.html
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = os.path.join(HERE, "keys")
PRIV = os.path.join(KEYS, "priv.pem")
PUB = os.path.join(KEYS, "pub.pem")
APP = os.path.join(KEYS, "application.json")
LOGO = os.path.join(HERE, "logo.png")
API = "https://api.monobank.ua"
FIELDS = ["name", "description", "contactPerson", "phone", "email"]


def der_to_raw(der: bytes) -> bytes:
    """ECDSA-подпись из DER (как её отдаёт openssl) в r||s по 32 байта, как ждёт банк."""
    def read_int(buf, i):
        assert buf[i] == 0x02
        n = buf[i + 1]
        return int.from_bytes(buf[i + 2:i + 2 + n], "big"), i + 2 + n

    assert der[0] == 0x30
    i = 2 + (der[1] & 0x7F) if der[1] & 0x80 else 2
    r, i = read_int(der, i)
    s, _ = read_int(der, i)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def raw_to_der(raw: bytes) -> bytes:
    def enc(x: bytes) -> bytes:
        x = x.lstrip(b"\0") or b"\0"
        if x[0] & 0x80:
            x = b"\0" + x
        return b"\x02" + bytes([len(x)]) + x

    body = enc(raw[:32]) + enc(raw[32:])
    return b"\x30" + bytes([len(body)]) + body


def openssl(*args, data: bytes) -> bytes:
    return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout


def sign(message: str) -> str:
    """X-Sign: SHA-256 + ECDSA secp256k1, подпись r||s в base64."""
    der = openssl("dgst", "-sha256", "-sign", PRIV, data=message.encode())
    raw = der_to_raw(der)
    # Проверяем, что после перевода в r||s подпись всё ещё сходится с открытым ключом.
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(raw_to_der(raw))
    try:
        out = openssl("dgst", "-sha256", "-verify", PUB, "-signature", f.name, data=message.encode())
        assert b"Verified OK" in out, out
    finally:
        os.unlink(f.name)
    return base64.b64encode(raw).decode()


def signed_headers(path: str) -> dict:
    t = str(int(time.time()))
    return {"X-Time": t, "X-Sign": sign(t + path), "Content-Type": "application/json"}


def pubkey_b64() -> str:
    with open(PUB, "rb") as f:
        # openssl под Windows пишет CRLF, а банк в примере ждёт PEM с LF.
        return base64.b64encode(f.read().replace(b"\r\n", b"\n")).decode()


def build_application() -> dict:
    with open(APP, encoding="utf-8") as f:
        app = json.load(f)
    missing = [k for k in FIELDS if not str(app.get(k, "")).strip()]
    if missing:
        sys.exit(f"В {APP} не заполнено: {', '.join(missing)}")
    with open(LOGO, "rb") as f:
        logo = base64.b64encode(f.read()).decode()
    return {"pubkey": pubkey_b64(), **{k: app[k] for k in FIELDS}, "logo": logo}


def post(path: str, body: dict):
    req = urllib.request.Request(API + path, data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers=signed_headers(path), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(r.status, r.read().decode())
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode())
        sys.exit(1)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        body = build_application()
        h = signed_headers("/personal/auth/registration")
        for k in FIELDS:
            print(f"{k:14} {body[k]}")
        print(f"{'description':14} длина {len(body['description'])} символов")
        print(f"{'logo':14} {len(body['logo'])} символов base64")
        print(f"{'pubkey':14} {body['pubkey'][:40]}…")
        print(f"X-Sign         {h['X-Sign']} (подпись проверена открытым ключом)")
        print("\nНичего не отправлено. Отправить: python monobank/register.py send")
    elif cmd == "send":
        post("/personal/auth/registration", build_application())
    elif cmd == "status":
        post("/personal/auth/registration/status", {"pubkey": pubkey_b64()})
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
