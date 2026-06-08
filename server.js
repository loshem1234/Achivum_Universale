require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const db                           = require('./database');
const { uploadPDF, deletePDF }     = require('./r2');
const { processBook, CATEGORIES, generateFallbackCover } = require('./ai');
const { runSeeds }                 = require('./seed');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  CATEGORIES.forEach(cat => { grouped[cat.id] = new Set(); });
  entries.forEach(e => {
    if (grouped[e.category]) {
      (e.tags || []).forEach(t => grouped[e.category].add(t));
    }
  });
  const result = {};
  Object.keys(grouped).forEach(k => { result[k] = [...grouped[k]].sort(); });
  res.json(result);
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

// ── ADMIN — AI PROCESSING (background job + polling) ──────────────────────────
//
// Flow:
//   POST /api/process  → starts background job, returns { jobId } immediately
//   GET  /api/process/:jobId → poll for status/progress/result
//
// This avoids all streaming/timeout issues on Railway.

app.post('/api/process', requireAdmin, upload.single('pdf'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided.' });
    const { title, author, year, language } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });

    // Create job record
    const jobId = uuidv4();
    jobs[jobId] = { status: 'running', step: 0, total: 5, message: 'Starting…', result: null, error: null };

    // Start processing in background — do NOT await
    const pdfBase64 = req.file.buffer.toString('base64');
    runProcessingJob(jobId, { pdfBase64, title, author, year, language, apiKey });

    // Return job ID immediately so browser can start polling
    res.json({ jobId });

    // Clean up job record after 30 minutes
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

// ── SPA FALLBACK ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

runSeeds();
app.listen(PORT, () => {
  console.log(`Archivum Universale running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
