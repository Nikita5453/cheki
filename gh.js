"use strict";
/* Storage in a private GitHub repo through the Contents API: data.json (budget and receipts) and photos/*.jpg.
   Works in the browser and in Node 18+ (used for tests). */

const GH = (() => {
  const API = "https://api.github.com";
  const EMPTY = () => ({ budget: null, receipts: [] });

  function b64FromBytes(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const b64FromText = text => b64FromBytes(new TextEncoder().encode(text));
  const textFromB64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));
  const encPath = p => p.split("/").map(encodeURIComponent).join("/");

  function normalize(d) {
    const out = d && typeof d === "object" ? d : EMPTY();
    if (!Array.isArray(out.receipts)) out.receipts = [];
    if (out.budget === undefined) out.budget = null;
    return out;
  }

  function connect({ token, repo }) {
    let sha = null, cache = null;

    async function call(path, opts = {}) {
      const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", ...(opts.headers || {}) };
      let r;
      try {
        r = await fetch(API + "/repos/" + repo + path, { cache: "no-store", ...opts, headers });
      } catch {
        const e = new Error("network"); e.status = 0; throw e;
      }
      return r;
    }
    async function fail(r) {
      const j = await r.json().catch(() => null);
      const e = new Error(j?.message || r.statusText || "error");
      e.status = r.status;
      throw e;
    }

    /* Repo access check: resolves {private, canPush}. */
    async function check() {
      const r = await call("");
      if (!r.ok) await fail(r);
      const j = await r.json();
      return { private: !!j.private, canPush: !!j.permissions?.push };
    }

    /* Reads data.json; `changed` is false when the file is the same version as the last read.
       No If-None-Match: GitHub can answer 304 with a stale copy, which kept recognized receipts looking pending. */
    async function load() {
      const r = await call("/contents/data.json");
      if (r.status === 404) { sha = null; cache = EMPTY(); return { data: cache, changed: true }; }
      if (!r.ok) await fail(r);
      const j = await r.json();
      if (cache && j.sha === sha) return { data: cache, changed: false };
      let text;
      if (j.content) text = textFromB64(j.content);
      else {
        const b = await call("/git/blobs/" + j.sha, { headers: { Accept: "application/vnd.github.raw+json" } });
        if (!b.ok) await fail(b);
        text = await b.text();
      }
      sha = j.sha;
      cache = normalize(JSON.parse(text));
      return { data: cache, changed: true };
    }

    /* Applies fn to a fresh copy and writes it; on a concurrent change re-reads and re-applies. */
    async function mutate(fn, message) {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0 || !cache) await load();
        const next = structuredClone(cache);
        if (fn(next) === false) return cache;
        const body = { message, content: b64FromText(JSON.stringify(next, null, 1) + "\n") };
        if (sha) body.sha = sha;
        const r = await call("/contents/data.json", {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        if (r.status === 409 || r.status === 422) continue;
        if (!r.ok) await fail(r);
        const j = await r.json();
        sha = j.content.sha; cache = next;
        return next;
      }
      const e = new Error("conflict"); e.status = 409; throw e;
    }

    async function putPhoto(path, blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const r = await call("/contents/" + encPath(path), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Фото чека", content: b64FromBytes(bytes) })
      });
      if (!r.ok) await fail(r);
    }

    async function getPhoto(path) {
      const r = await call("/contents/" + encPath(path), { headers: { Accept: "application/vnd.github.raw+json" } });
      if (!r.ok) await fail(r);
      return r.blob();
    }

    async function deleteFile(path) {
      const m = await call("/contents/" + encPath(path));
      if (!m.ok) return false;
      const j = await m.json();
      const r = await call("/contents/" + encPath(path), {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Удалено фото чека", sha: j.sha })
      });
      return r.ok;
    }

    return { check, load, mutate, putPhoto, getPhoto, deleteFile };
  }

  return { connect };
})();

if (typeof module !== "undefined") module.exports = GH;
