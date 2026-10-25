"use strict";
/* Supabase storage for «Бюджет по чекам»: Google sign-in, books (сборки), members, invite links, receipts and photos.
   Row level security in the database decides what each signed-in person may see and change. */

const SB = (() => {
  const cfg = window.CHEKI_CONFIG;
  const client = supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, detectSessionInUrl: true } });

  async function q(promise) {
    const { data, error } = await promise;
    if (error) { const e = new Error(error.message); e.code = error.code; e.status = error.status; throw e; }
    return data;
  }

  const fromDb = r => ({
    id: r.id, bookId: r.book_id, author: r.author, status: r.status, date: r.date, store: r.store || "",
    total: +r.total || 0, items: r.items || [], photos: r.photos || [], manual: !!r.manual, error: r.error || "",
    createdAt: r.created_at, updatedAt: r.updated_at
  });
  const toDb = r => ({
    id: r.id, book_id: r.bookId, status: r.status || "done", date: r.date || null, store: r.store || "",
    total: r.total || 0, items: r.items || [], photos: r.photos || [], manual: !!r.manual, error: r.error || null,
    updated_at: new Date().toISOString(), ...(r.author ? { author: r.author } : {})
  });

  return {
    client,

    /* ---------- auth ---------- */
    async session() { return (await client.auth.getSession()).data.session; },
    /* The callback runs while supabase-js holds its auth lock; any query made inside it waits for that lock forever.
       Hand the session over on the next tick so the app's own queries run after the lock is released. */
    onAuth(fn) { client.auth.onAuthStateChange((_event, session) => { setTimeout(() => fn(session), 0); }); },
    signIn() {
      return client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
    },
    signOut() { return client.auth.signOut(); },

    /* ---------- books and people ---------- */
    async books() {
      const [books, members] = await Promise.all([
        q(client.from("books").select("*").order("created_at")),
        q(client.from("book_members").select("book_id, user_id, role, joined_at"))
      ]);
      const ids = [...new Set(members.map(m => m.user_id))];
      const profiles = ids.length ? await q(client.from("profiles").select("id, name, email, avatar").in("id", ids)) : [];
      const prof = Object.fromEntries(profiles.map(p => [p.id, p]));
      return books.map(b => ({
        id: b.id, name: b.name, owner: b.owner, budget: b.monthly_budget == null ? null : +b.monthly_budget, startDate: b.start_date,
        members: members.filter(m => m.book_id === b.id)
          .map(m => ({ userId: m.user_id, role: m.role, ...(prof[m.user_id] || {}) }))
          .sort((a, c) => (a.role === "owner" ? -1 : c.role === "owner" ? 1 : 0))
      }));
    },
    createBook: b => q(client.from("books").insert({ name: b.name, monthly_budget: b.budget, start_date: b.startDate }).select().single()),
    updateBook: (id, b) => q(client.from("books").update({ name: b.name, monthly_budget: b.budget, start_date: b.startDate }).eq("id", id)),
    deleteBook: id => q(client.from("books").delete().eq("id", id)),
    removeMember: (bookId, userId) => q(client.from("book_members").delete().eq("book_id", bookId).eq("user_id", userId)),

    /* One reusable invite link per book. */
    async inviteToken(bookId) {
      const have = await q(client.from("invites").select("token").eq("book_id", bookId).order("created_at").limit(1));
      if (have.length) return have[0].token;
      return (await q(client.from("invites").insert({ book_id: bookId }).select("token").single())).token;
    },
    async join(token) {
      const rows = await q(client.rpc("join_book", { invite: token }));
      return rows[0] || null;
    },

    /* ---------- receipts ---------- */
    async receipts(bookId) {
      return (await q(client.from("receipts").select("*").eq("book_id", bookId).order("date", { ascending: false }))).map(fromDb);
    },
    async upsertReceipt(r) { return fromDb(await q(client.from("receipts").upsert(toDb(r)).select().single())); },
    async patchReceipt(id, patch) {
      const row = {};
      for (const [k, v] of Object.entries(patch)) row[{ bookId: "book_id" }[k] || k] = v;
      row.updated_at = new Date().toISOString();
      return fromDb(await q(client.from("receipts").update(row).eq("id", id).select().single()));
    },
    deleteReceipt: id => q(client.from("receipts").delete().eq("id", id)),
    async receipt(id) { return fromDb(await q(client.from("receipts").select("*").eq("id", id).single())); },

    /* Cloud recognition (Edge Function «recognize», Gemini). Resolves with {status, error?}. */
    async recognize(id) {
      const { data, error } = await client.functions.invoke("recognize", { body: { id } });
      if (error) { const e = new Error(error.message || "recognize failed"); e.status = error.context?.status; throw e; }
      return data || {};
    },

    /* ---------- photos (private bucket, path «<uploader id>/<file>») ---------- */
    putPhoto: (path, blob) => q(client.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", upsert: true })),
    getPhoto: path => q(client.storage.from("photos").download(path)),
    deletePhotos: paths => paths.length ? q(client.storage.from("photos").remove(paths)) : Promise.resolve()
  };
})();
