require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const db                           = require('./database');
const { uploadPDF, deletePDF, getPresignedUploadUrl } = require('./r2');
const { processBook, CATEGORIES, generateFallbackCover } = require('./ai');
const { runSeeds }                 = require('./seed');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'Public')));

// In-memory job store — tracks background AI processing jobs
// { [jobId]: { status, step, total, message, result, error } }
const jobs = {};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted.'));
  },
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
const ADMIN_HASH = bcrypt.hashSync(process.env.ADMIN_PASSPHRASE || 'archivum2024', 10);
const TOKENS     = new Set();

function issueToken() {
  const token = uuidv4();
  TOKENS.add(token);
  setTimeout(() => TOKENS.delete(token), 8 * 60 * 60 * 1000);
  return token;
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !TOKENS.has(token)) return res.status(401).json({ error: 'Unauthorised' });
  next();
}

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/login', (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || !bcrypt.compareSync(passphrase, ADMIN_HASH))
    return res.status(401).json({ error: 'Incorrect passphrase.' });
  res.json({ token: issueToken() });
});

app.get('/api/entries', (req, res) => {
  const { q, category, tag } = req.query;
  let entries = q ? db.search(q) : db.getAll();
  if (category) entries = entries.filter(e => e.category === category);
  if (tag)      entries = entries.filter(e => (e.tags || []).includes(tag));
  res.json(entries);
});

app.get('/api/entries/:id', (req, res) => {
  const entry = db.getById(req.params.id);
  if (!entry || entry.hidden) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

app.get('/api/stats', (req, res) => res.json(db.stats()));

app.get('/api/tags', (req, res) => {
  const entries = db.getAll();
  const grouped = {};
  CATEGORIES.forEach(cat => { grouped[cat.id] = {}; });
  entries.forEach(e => {
    if (grouped[e.category]) {
      (e.tags || []).forEach(t => {
        grouped[e.category][t] = (grouped[e.category][t] || 0) + 1;
      });
    }
  });
  // Sort by frequency descending, ties alphabetically
  const result = {};
  Object.keys(grouped).forEach(catId => {
    const counts = grouped[catId];
    result[catId] = Object.keys(counts).sort((a, b) =>
      counts[b] !== counts[a] ? counts[b] - counts[a] : a.localeCompare(b)
    );
  });
  res.json(result);
});

// Recommendations — up to 6 entries similar to the given one
app.get('/api/recommendations/:id', (req, res) => {
  const entry = db.getById(req.params.id);
  if (!entry || entry.hidden) return res.status(404).json({ error: 'Not found' });
  const entryTags = new Set(entry.tags || []);
  const all = db.getAll().filter(e => e.id !== entry.id);
  const scored = all.map(e => {
    const shared  = (e.tags || []).filter(t => entryTags.has(t)).length;
    const sameCat = e.category === entry.category ? 2 : 0;
    return { e, score: shared * 3 + sameCat };
  });
  const recs = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(s => s.e);
  res.json(recs);
});

// ── ADMIN — ENTRIES ───────────────────────────────────────────────────────────
app.post('/api/entries', requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const body = JSON.parse(req.body.data || '{}');
    const { title, author, year, language, category, summary, note, tags, cover_svg } = body;
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    let pdf_key = null, pdf_url = null, pdf_filename = null;
    if (req.file) {
      const r  = await uploadPDF(req.file.buffer, req.file.originalname);
      pdf_key      = r.key;
      pdf_url      = r.url;
      pdf_filename = r.filename;
    }

    const cat   = CATEGORIES.find(c => c.id === category) || CATEGORIES[1];
    const saved = db.insert({
      id: uuidv4(), title, author: author||'', year: year||'',
      language: language||'English', category: cat.id,
      summary: summary||'', note: note||'',
      tags: Array.isArray(tags) ? tags : [],
      cover_svg: cover_svg || generateFallbackCover(title, cat),
      pdf_key, pdf_url, pdf_filename, is_seed: false, hidden: false,
    });
    res.status(201).json(saved);
  } catch (err) {
    console.error('[POST /api/entries]', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/entries/:id', requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const existing = db.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const body = JSON.parse(req.body.data || '{}');
    const { title, author, year, language, category, summary, note, tags, cover_svg } = body;

    let { pdf_key, pdf_url, pdf_filename } = existing;
    if (req.file) {
      if (existing.pdf_key) await deletePDF(existing.pdf_key).catch(() => {});
      const r  = await uploadPDF(req.file.buffer, req.file.originalname);
      pdf_key      = r.key;
      pdf_url      = r.url;
      pdf_filename = r.filename;
    }

    const cat     = CATEGORIES.find(c => c.id === category) || CATEGORIES[1];
    const updated = db.update({
      ...existing, title, author: author||existing.author,
      year: year||existing.year, language: language||existing.language,
      category: cat.id, summary: summary??existing.summary,
      note: note??existing.note,
      tags: Array.isArray(tags) ? tags : existing.tags,
      cover_svg: cover_svg||existing.cover_svg,
      pdf_key, pdf_url, pdf_filename,
    });
    res.json(updated);
  } catch (err) {
    console.error('[PUT /api/entries/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/entries/:id', requireAdmin, async (req, res) => {
  try {
    const entry = db.getById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (!entry.is_seed && entry.pdf_key) await deletePDF(entry.pdf_key).catch(() => {});
    db.delete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/entries/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN — AI PROCESSING ────────────────────────────────────────────────────
//
// Two-step flow to avoid Railway proxy size limits:
//   1. GET  /api/process/presign?filename=x.pdf
//         → returns { uploadUrl, key, publicUrl }
//         → browser uploads PDF directly to R2 (bypasses Railway)
//   2. POST /api/process  { r2Key, title, author, year, language }
//         → server fetches PDF from R2, starts background job
//         → returns { jobId }
//   3. GET  /api/process/:jobId → poll for status/result

// Step 1 — get a presigned R2 upload URL
app.get('/api/process/presign', requireAdmin, async (req, res) => {
  try {
    const filename = req.query.filename || 'upload.pdf';
    const result   = await getPresignedUploadUrl(filename);
    res.json(result);
  } catch (err) {
    console.error('[GET /api/process/presign]', err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2 — start AI processing job using the R2 key
app.post('/api/process', requireAdmin, async (req, res) => {
  try {
    const { r2Key, r2Url, title, author, year, language } = req.body;
    if (!r2Key)  return res.status(400).json({ error: 'r2Key is required.' });
    if (!title)  return res.status(400).json({ error: 'Title is required.' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });

    // Fetch the PDF from R2 and convert to base64
    const pdfResp = await fetch(r2Url);
    if (!pdfResp.ok) throw new Error(`Could not fetch PDF from storage (${pdfResp.status})`);
    const pdfBuffer = await pdfResp.arrayBuffer();
    const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

    const jobId = uuidv4();
    jobs[jobId] = { status: 'running', step: 0, total: 5, message: 'Starting…', result: null, error: null };

    runProcessingJob(jobId, { pdfBase64, title, author, year, language, apiKey, r2Key });

    res.json({ jobId });
    setTimeout(() => { delete jobs[jobId]; }, 30 * 60 * 1000);

  } catch (err) {
    console.error('[POST /api/process]', err);
    res.status(500).json({ error: err.message });
  }
});

// Poll for job status
app.get('/api/process/:jobId', requireAdmin, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json(job);
});

async function runProcessingJob(jobId, params) {
  try {
    const result = await processBook({
      ...params,
      onProgress: (step, total, message) => {
        if (jobs[jobId]) {
          jobs[jobId].step    = step;
          jobs[jobId].total   = total;
          jobs[jobId].message = message;
        }
      },
    });
    if (jobs[jobId]) {
      jobs[jobId].status = 'complete';
      jobs[jobId].result = result;
      jobs[jobId].step   = 5;
      jobs[jobId].message = 'Complete';
    }
  } catch (err) {
    console.error('[AI job]', err);
    if (jobs[jobId]) {
      jobs[jobId].status = 'error';
      jobs[jobId].error  = err.message;
    }
  }
}


// ── SANCTUM ROUTES ────────────────────────────────────────────────────────────

const SANCTUM_PASSPHRASE = process.env.SANCTUM_PASSPHRASE || 'thewordislight';
const SANCTUM_TOKENS = new Set();

function issueSanctumToken() {
  const token = uuidv4();
  SANCTUM_TOKENS.add(token);
  setTimeout(() => SANCTUM_TOKENS.delete(token), 24 * 60 * 60 * 1000); // 24hr
  return token;
}

function requireSanctum(req, res, next) {
  const token = req.headers['x-sanctum-token'];
  if (!token || !SANCTUM_TOKENS.has(token)) return res.status(401).json({ error: 'Access denied.' });
  next();
}

// Sanctum pages — serve static HTML files
app.get('/sanctum', (req, res) => {
  res.sendFile(path.join(__dirname, 'Public', 'sanctum.html'));
});
app.get('/sanctum/inner', (req, res) => {
  res.sendFile(path.join(__dirname, 'Public', 'sanctum-inner.html'));
});

// Register
app.post('/api/sanctum/register', async (req, res) => {
  try {
    const { username, email, password, passphrase } = req.body;
    if (!username || !email || !password || !passphrase)
      return res.status(400).json({ error: 'All fields are required.' });
    if (passphrase !== SANCTUM_PASSPHRASE)
      return res.status(403).json({ error: 'The passphrase is incorrect.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.sanctum.findByUsername(username))
      return res.status(409).json({ error: 'That username is already taken.' });
    if (db.sanctum.findByEmail(email))
      return res.status(409).json({ error: 'That email is already registered.' });

    const hashed = bcrypt.hashSync(password, 10);
    const id = uuidv4();
    db.sanctum.insert({ id, username, email, password: hashed });
    const token = issueSanctumToken();
    res.status(201).json({ token, username, id });
  } catch (err) {
    console.error('[sanctum/register]', err);
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/sanctum/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required.' });
    const user = db.sanctum.findByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Incorrect username or password.' });
    db.sanctum.updateLogin(user.id);
    const token = issueSanctumToken();
    res.json({ token, username: user.username, id: user.id });
  } catch (err) {
    console.error('[sanctum/login]', err);
    res.status(500).json({ error: err.message });
  }
});

// Verify token — used by inner page to check auth
app.get('/api/sanctum/verify', requireSanctum, (req, res) => {
  res.json({ ok: true });
});

// Admin — list sanctum members
app.get('/api/sanctum/members', requireAdmin, (req, res) => {
  res.json(db.sanctum.listAll());
});


// ── SANCTUM ARTICLE ROUTES ────────────────────────────────────────────────────

// Public-to-sanctum: get articles by section (requires sanctum token)
app.get('/api/sanctum/articles/:section', requireSanctum, (req, res) => {
  const { section } = req.params;
  const { category } = req.query;
  let articles = db.articles.getBySection(section);
  if (category) articles = articles.filter(a => a.category === category);
  res.json(articles);
});

app.get('/api/sanctum/articles/:section/categories', requireSanctum, (req, res) => {
  res.json(db.articles.categories(req.params.section));
});

app.get('/api/sanctum/article/:id', requireSanctum, (req, res) => {
  const a = db.articles.getById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json(a);
});

// Admin: create article
app.post('/api/sanctum/articles', requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const body = JSON.parse(req.body.data || '{}');
    const { section, title, category, articleBody, source_book, source_author, domain } = body;
    if (!title || !section) return res.status(400).json({ error: 'Title and section are required.' });

    let pdf_key=null, pdf_url=null, pdf_filename=null;
    if (req.file) {
      const r = await uploadPDF(req.file.buffer, req.file.originalname);
      pdf_key=r.key; pdf_url=r.url; pdf_filename=r.filename;
    }

    const id = uuidv4();
    db.articles.insert({
      id, section, title,
      category: category||null,
      body: articleBody||'',
      source_book: source_book||null,
      source_author: source_author||null,
      domain: domain||null,
      pdf_key, pdf_url, pdf_filename,
    });
    res.status(201).json(db.articles.getById(id));
  } catch(err) {
    console.error('[POST /api/sanctum/articles]', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: update article
app.put('/api/sanctum/article/:id', requireAdmin, (req, res) => {
  try {
    const existing = db.articles.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { title, category, articleBody, source_book, source_author, domain } = req.body;
    db.articles.update({
      id: req.params.id,
      title: title||existing.title,
      category: category||existing.category,
      body: articleBody??existing.body,
      source_book: source_book||existing.source_book,
      source_author: source_author||existing.source_author,
      domain: domain||existing.domain,
    });
    res.json(db.articles.getById(req.params.id));
  } catch(err) {
    console.error('[PUT /api/sanctum/article]', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: delete article
app.delete('/api/sanctum/article/:id', requireAdmin, async (req, res) => {
  try {
    const a = db.articles.getById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.pdf_key) await deletePDF(a.pdf_key).catch(()=>{});
    db.articles.delete(req.params.id);
    res.json({ ok: true });
  } catch(err) {
    console.error('[DELETE /api/sanctum/article]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SPA FALLBACK ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

runSeeds();
app.listen(PORT, () => {
  console.log(`Archivum Universale running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
