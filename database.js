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

  CREATE TABLE IF NOT EXISTS sanctum_articles (
    id          TEXT PRIMARY KEY,
    section     TEXT NOT NULL,
    title       TEXT NOT NULL,
    category    TEXT,
    body        TEXT,
    source_book TEXT,
    source_author TEXT,
    domain      TEXT,
    pdf_key     TEXT,
    pdf_url     TEXT,
    pdf_filename TEXT,
    published   INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agora_figures (
    id              TEXT PRIMARY KEY,
    hall            TEXT NOT NULL,
    name            TEXT NOT NULL,
    era_dates       TEXT,
    epithet         TEXT,
    voice_notes     TEXT,
    temperament     TEXT,
    characteristic_phrases TEXT,
    core_doctrines  TEXT,
    reasoning_method TEXT,
    domain_tags     TEXT,
    relationships   TEXT,
    primary_works   TEXT,
    portrait_prompt TEXT,
    portrait_svg    TEXT,
    bio_html        TEXT,
    bibliography_html TEXT,
    bio_generated_at TEXT,
    hidden          INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agora_chunks (
    id              TEXT PRIMARY KEY,
    figure_id       TEXT NOT NULL REFERENCES agora_figures(id) ON DELETE CASCADE,
    work_title      TEXT,
    structural_mode TEXT,
    content         TEXT NOT NULL,
    embedding       TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agora_chunks_figure ON agora_chunks(figure_id);

  CREATE TABLE IF NOT EXISTS agora_conversations (
    id              TEXT PRIMARY KEY,
    hall            TEXT NOT NULL,
    mode            TEXT NOT NULL,
    autonomous      INTEGER DEFAULT 0,
    figure_ids      TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agora_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agora_conversations(id) ON DELETE CASCADE,
    speaker         TEXT NOT NULL,
    speaker_figure_id TEXT,
    content         TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agora_messages_conv ON agora_messages(conversation_id);
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

const articleQueries = {
  getBySection: db.prepare(`SELECT * FROM sanctum_articles WHERE section=? AND published=1 ORDER BY created_at DESC`),
  getById:      db.prepare(`SELECT * FROM sanctum_articles WHERE id=?`),
  insert:       db.prepare(`INSERT INTO sanctum_articles (id,section,title,category,body,source_book,source_author,domain,pdf_key,pdf_url,pdf_filename) VALUES (@id,@section,@title,@category,@body,@source_book,@source_author,@domain,@pdf_key,@pdf_url,@pdf_filename)`),
  update:       db.prepare(`UPDATE sanctum_articles SET title=@title,category=@category,body=@body,source_book=@source_book,source_author=@source_author,domain=@domain,updated_at=datetime('now') WHERE id=@id`),
  delete:       db.prepare(`DELETE FROM sanctum_articles WHERE id=?`),
  categories:   db.prepare(`SELECT DISTINCT category FROM sanctum_articles WHERE section=? AND category IS NOT NULL AND published=1 ORDER BY category`),
};

// ── AGORA (Symposium & Pantheon) ─────────────────────────────────────────────
const agoraQueries = {
  listFigures: db.prepare(`SELECT id,hall,name,era_dates,epithet,portrait_svg,domain_tags FROM agora_figures WHERE hidden=0 ORDER BY hall, name`),
  listFiguresByHall: db.prepare(`SELECT id,hall,name,era_dates,epithet,portrait_svg,domain_tags FROM agora_figures WHERE hall=? AND hidden=0 ORDER BY name`),
  getFigureById: db.prepare(`SELECT * FROM agora_figures WHERE id=?`),
  insertFigure: db.prepare(`
    INSERT INTO agora_figures
      (id,hall,name,era_dates,epithet,voice_notes,temperament,characteristic_phrases,
       core_doctrines,reasoning_method,domain_tags,relationships,primary_works,
       portrait_prompt,portrait_svg,hidden)
    VALUES
      (@id,@hall,@name,@era_dates,@epithet,@voice_notes,@temperament,@characteristic_phrases,
       @core_doctrines,@reasoning_method,@domain_tags,@relationships,@primary_works,
       @portrait_prompt,@portrait_svg,@hidden)
  `),
  updateFigure: db.prepare(`
    UPDATE agora_figures SET
      hall=@hall, name=@name, era_dates=@era_dates, epithet=@epithet,
      voice_notes=@voice_notes, temperament=@temperament,
      characteristic_phrases=@characteristic_phrases, core_doctrines=@core_doctrines,
      reasoning_method=@reasoning_method, domain_tags=@domain_tags,
      relationships=@relationships, primary_works=@primary_works,
      portrait_prompt=@portrait_prompt, portrait_svg=@portrait_svg,
      updated_at=datetime('now')
    WHERE id=@id
  `),
  updateBioPage: db.prepare(`
    UPDATE agora_figures SET bio_html=@bio_html, bibliography_html=@bibliography_html,
      bio_generated_at=datetime('now'), updated_at=datetime('now')
    WHERE id=@id
  `),
  softDeleteFigure: db.prepare(`UPDATE agora_figures SET hidden=1, updated_at=datetime('now') WHERE id=?`),

  insertChunk: db.prepare(`
    INSERT INTO agora_chunks (id,figure_id,work_title,structural_mode,content,embedding)
    VALUES (@id,@figure_id,@work_title,@structural_mode,@content,@embedding)
  `),
  getChunksByFigure: db.prepare(`SELECT id,content,embedding FROM agora_chunks WHERE figure_id=?`),
  countChunksByFigure: db.prepare(`SELECT COUNT(*) as n FROM agora_chunks WHERE figure_id=?`),
  deleteChunksByFigure: db.prepare(`DELETE FROM agora_chunks WHERE figure_id=?`),
  listWorksByFigure: db.prepare(`SELECT DISTINCT work_title FROM agora_chunks WHERE figure_id=? AND work_title IS NOT NULL AND work_title != ''`),

  insertConversation: db.prepare(`
    INSERT INTO agora_conversations (id,hall,mode,autonomous,figure_ids)
    VALUES (@id,@hall,@mode,@autonomous,@figure_ids)
  `),
  getConversationById: db.prepare(`SELECT * FROM agora_conversations WHERE id=?`),

  insertMessage: db.prepare(`
    INSERT INTO agora_messages (id,conversation_id,speaker,speaker_figure_id,content)
    VALUES (@id,@conversation_id,@speaker,@speaker_figure_id,@content)
  `),
  getMessagesByConversation: db.prepare(`SELECT * FROM agora_messages WHERE conversation_id=? ORDER BY created_at ASC`),
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

  articles: {
    getBySection(section)  { return articleQueries.getBySection.all(section); },
    getById(id)            { return articleQueries.getById.get(id); },
    insert(a)              { return articleQueries.insert.run(a); },
    update(a)              { return articleQueries.update.run(a); },
    delete(id)             { return articleQueries.delete.run(id); },
    categories(section)    { return articleQueries.categories.all(section).map(r=>r.category); },
  },

  // Agora — Symposium & Pantheon living personas
  agora: {
    listFigures() {
      return agoraQueries.listFigures.all();
    },
    listFiguresByHall(hall) {
      return agoraQueries.listFiguresByHall.all(hall);
    },
    getFigureById(id) {
      const row = agoraQueries.getFigureById.get(id);
      return row ? { ...row, hidden: Boolean(row.hidden) } : null;
    },
    insertFigure(f) {
      agoraQueries.insertFigure.run(serializeFigure(f));
      return this.getFigureById(f.id);
    },
    updateFigure(f) {
      agoraQueries.updateFigure.run(serializeFigure(f));
      return this.getFigureById(f.id);
    },
    updateBioPage(id, bioHtml, bibliographyHtml) {
      agoraQueries.updateBioPage.run({ id, bio_html: bioHtml, bibliography_html: bibliographyHtml });
      return this.getFigureById(id);
    },
    deleteFigure(id) {
      agoraQueries.deleteChunksByFigure.run(id);
      agoraQueries.softDeleteFigure.run(id);
    },
    insertChunks(figureId, chunkRows) {
      const insertMany = db.transaction((rows) => {
        for (const r of rows) {
          agoraQueries.insertChunk.run({
            id: r.id,
            figure_id: figureId,
            work_title: r.work_title || '',
            structural_mode: r.structural_mode || '',
            content: r.content,
            embedding: JSON.stringify(r.embedding),
          });
        }
      });
      insertMany(chunkRows);
    },
    getChunksByFigure(figureId) {
      return agoraQueries.getChunksByFigure.all(figureId).map(r => ({
        id: r.id, content: r.content, embedding: JSON.parse(r.embedding),
      }));
    },
    countChunksByFigure(figureId) {
      return agoraQueries.countChunksByFigure.get(figureId).n;
    },
    clearChunksForFigure(figureId) {
      agoraQueries.deleteChunksByFigure.run(figureId);
    },
    listWorksByFigure(figureId) {
      return agoraQueries.listWorksByFigure.all(figureId).map(r => r.work_title);
    },
    insertConversation(c) {
      agoraQueries.insertConversation.run({
        id: c.id, hall: c.hall, mode: c.mode,
        autonomous: c.autonomous ? 1 : 0,
        figure_ids: JSON.stringify(c.figure_ids || []),
      });
      return this.getConversationById(c.id);
    },
    getConversationById(id) {
      const row = agoraQueries.getConversationById.get(id);
      if (!row) return null;
      return { ...row, autonomous: Boolean(row.autonomous), figure_ids: JSON.parse(row.figure_ids) };
    },
    insertMessage(m) {
      agoraQueries.insertMessage.run({
        id: m.id, conversation_id: m.conversation_id,
        speaker: m.speaker, speaker_figure_id: m.speaker_figure_id || null,
        content: m.content,
      });
    },
    getMessagesByConversation(conversationId) {
      return agoraQueries.getMessagesByConversation.all(conversationId);
    },
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

function serializeFigure(f) {
  return {
    id: f.id,
    hall: f.hall || 'symposium',
    name: f.name || '',
    era_dates: f.era_dates || '',
    epithet: f.epithet || '',
    voice_notes: f.voice_notes || '',
    temperament: f.temperament || '',
    characteristic_phrases: f.characteristic_phrases || '',
    core_doctrines: f.core_doctrines || '',
    reasoning_method: f.reasoning_method || '',
    domain_tags: f.domain_tags || '',
    relationships: f.relationships || '',
    primary_works: f.primary_works || '',
    portrait_prompt: f.portrait_prompt || '',
    portrait_svg: f.portrait_svg || null,
    hidden: f.hidden ? 1 : 0,
  };
}
