const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Persist database in /data on Railway (persistent volume) or local ./data
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'archivum.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    author      TEXT,
    year        TEXT,
    language    TEXT DEFAULT 'English',
    category    TEXT NOT NULL,
    summary     TEXT,
    note        TEXT,
    tags        TEXT DEFAULT '[]',
    cover_svg   TEXT,
    pdf_key     TEXT,
    pdf_url     TEXT,
    pdf_filename TEXT,
    is_seed     INTEGER DEFAULT 0,
    hidden      INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS seed_hidden (
    seed_id TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS sanctum_users (
    id          TEXT PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    status      TEXT DEFAULT 'active',
    created_at  TEXT DEFAULT (datetime('now')),
    last_login  TEXT
  );
`);

// ── QUERIES ─────────────────────────────────────────────────────────────────
const queries = {

  getAllVisible: db.prepare(`
    SELECT * FROM entries
    WHERE hidden = 0
    ORDER BY is_seed DESC, created_at ASC
  `),

  getById: db.prepare(`SELECT * FROM entries WHERE id = ?`),

  insert: db.prepare(`
    INSERT INTO entries
      (id, title, author, year, language, category, summary, note, tags,
       cover_svg, pdf_key, pdf_url, pdf_filename, is_seed, hidden)
    VALUES
      (@id, @title, @author, @year, @language, @category, @summary, @note, @tags,
       @cover_svg, @pdf_key, @pdf_url, @pdf_filename, @is_seed, @hidden)
  `),

  update: db.prepare(`
    UPDATE entries SET
      title       = @title,
      author      = @author,
      year        = @year,
      language    = @language,
      category    = @category,
      summary     = @summary,
      note        = @note,
      tags        = @tags,
      cover_svg   = @cover_svg,
      pdf_key     = @pdf_key,
      pdf_url     = @pdf_url,
      pdf_filename = @pdf_filename,
      updated_at  = datetime('now')
    WHERE id = @id
  `),

  softDelete: db.prepare(`
    UPDATE entries SET hidden = 1, updated_at = datetime('now') WHERE id = ?
  `),

  restore: db.prepare(`
    UPDATE entries SET hidden = 0, updated_at = datetime('now') WHERE id = ?
  `),

  hardDelete: db.prepare(`DELETE FROM entries WHERE id = ?`),

  search: db.prepare(`
    SELECT * FROM entries
    WHERE hidden = 0 AND (
      title    LIKE @q OR
      author   LIKE @q OR
      summary  LIKE @q OR
      note     LIKE @q OR
      tags     LIKE @q
    )
    ORDER BY is_seed DESC, created_at ASC
  `),

  stats: db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT category) as domains,
      COUNT(CASE WHEN pdf_url IS NOT NULL THEN 1 END) as with_pdf
    FROM entries WHERE hidden = 0
  `),
};

const sanctumQueries = {
  findByUsername: db.prepare(`SELECT * FROM sanctum_users WHERE username = ? AND status = 'active'`),
  findByEmail:    db.prepare(`SELECT * FROM sanctum_users WHERE email = ? AND status = 'active'`),
  findById:       db.prepare(`SELECT * FROM sanctum_users WHERE id = ?`),
  insert:         db.prepare(`INSERT INTO sanctum_users (id,username,email,password) VALUES (@id,@username,@email,@password)`),
  updateLogin:    db.prepare(`UPDATE sanctum_users SET last_login=datetime('now') WHERE id=?`),
  listAll:        db.prepare(`SELECT id,username,email,status,created_at,last_login FROM sanctum_users ORDER BY created_at DESC`),
  setStatus:      db.prepare(`UPDATE sanctum_users SET status=? WHERE id=?`),
};

// ── PUBLIC API ───────────────────────────────────────────────────────────────
module.exports = {
  getAll() {
    const rows = queries.getAllVisible.all();
    return rows.map(parseEntry);
  },

  getById(id) {
    const row = queries.getById.get(id);
    return row ? parseEntry(row) : null;
  },

  insert(entry) {
    queries.insert.run(serializeEntry(entry));
    return this.getById(entry.id);
  },

  update(entry) {
    queries.update.run(serializeEntry(entry));
    return this.getById(entry.id);
  },

  delete(id) {
    // Soft-delete — keeps the record, marks hidden
    queries.softDelete.run(id);
  },

  hardDelete(id) {
    queries.hardDelete.run(id);
  },

  search(q) {
    const rows = queries.search.all({ q: `%${q}%` });
    return rows.map(parseEntry);
  },

  stats() {
    return queries.stats.get();
  },

  // Sanctum user methods
  sanctum: {
    findByUsername(username) { return sanctumQueries.findByUsername.get(username); },
    findByEmail(email)       { return sanctumQueries.findByEmail.get(email); },
    findById(id)             { return sanctumQueries.findById.get(id); },
    insert(user)             { return sanctumQueries.insert.run(user); },
    updateLogin(id)          { return sanctumQueries.updateLogin.run(id); },
    listAll()                { return sanctumQueries.listAll.all(); },
    setStatus(id, status)    { return sanctumQueries.setStatus.run(status, id); },
  },
};

// ── HELPERS ──────────────────────────────────────────────────────────────────
function parseEntry(row) {
  return {
    ...row,
    tags: safeParseJSON(row.tags, []),
    is_seed: Boolean(row.is_seed),
    hidden: Boolean(row.hidden),
  };
}

function serializeEntry(e) {
  return {
    id:           e.id,
    title:        e.title || '',
    author:       e.author || '',
    year:         e.year || '',
    language:     e.language || 'English',
    category:     e.category || 'philosophy',
    summary:      e.summary || '',
    note:         e.note || '',
    tags:         JSON.stringify(Array.isArray(e.tags) ? e.tags : []),
    cover_svg:    e.cover_svg || null,
    pdf_key:      e.pdf_key || null,
    pdf_url:      e.pdf_url || null,
    pdf_filename: e.pdf_filename || null,
    is_seed:      e.is_seed ? 1 : 0,
    hidden:       e.hidden ? 1 : 0,
  };
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}
