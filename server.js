require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const db              = require('./database');
const { uploadPDF, deletePDF } = require('./r2');
const { processBook, CATEGORIES, generateFallbackCover } = require('./ai');
const { runSeeds }    = require('./seed');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer — store upload in memory, then push to R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted.'));
  },
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
// Simple passphrase check — returns a short-lived token stored in sessionStorage
const ADMIN_HASH = bcrypt.hashSync(
  process.env.ADMIN_PASSPHRASE || 'archivum2024',
  10
);

// Very lightweight "token" — just a signed timestamp.
// For production, swap this for JWT or a proper session library.
const TOKENS = new Set();

function issueToken() {
  const token = uuidv4();
  TOKENS.add(token);
  // Expire after 8 hours
  setTimeout(() => TOKENS.delete(token), 8 * 60 * 60 * 1000);
  return token;
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !TOKENS.has(token)) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Login
app.post('/api/auth/login', (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || !bcrypt.compareSync(passphrase, ADMIN_HASH)) {
    return res.status(401).json({ error: 'Incorrect passphrase.' });
  }
  res.json({ token: issueToken() });
});

// ── ENTRIES (public) ──────────────────────────────────────────────────────

// Get all visible entries
app.get('/api/entries', (req, res) => {
  const { q } = req.query;
  const entries = q ? db.search(q) : db.getAll();
  res.json(entries);
});

// Get single entry
app.get('/api/entries/:id', (req, res) => {
  const entry = db.getById(req.params.id);
  if (!entry || entry.hidden) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

// Stats
app.get('/api/stats', (req, res) => {
  res.json(db.stats());
});

// ── ENTRIES (admin) ───────────────────────────────────────────────────────

// Create new entry (with optional PDF upload)
app.post('/api/entries', requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const body = JSON.parse(req.body.data || '{}');
    const { title, author, year, language, category, summary, note, tags, cover_svg } = body;

    if (!title) return res.status(400).json({ error: 'Title is required.' });

    let pdf_key = null, pdf_url = null, pdf_filename = null;

    if (req.file) {
      const result = await uploadPDF(req.file.buffer, req.file.originalname);
      pdf_key      = result.key;
      pdf_url      = result.url;
      pdf_filename = result.filename;
    }

    const cat    = CATEGORIES.find(c => c.id === category) || CATEGORIES[1];
    const entry  = {
      id:        uuidv4(),
      title,
      author:    author    || '',
      year:      year      || '',
      language:  language  || 'English',
      category:  cat.id,
      summary:   summary   || '',
      note:      note      || '',
      tags:      Array.isArray(tags) ? tags : [],
      cover_svg: cover_svg || generateFallbackCover(title, cat),
      pdf_key,
      pdf_url,
      pdf_filename,
      is_seed:   false,
      hidden:    false,
    };

    const saved = db.insert(entry);
    res.status(201).json(saved);
  } catch (err) {
    console.error('[POST /api/entries]', err);
    res.status(500).json({ error: err.message });
  }
});

// Update entry
app.put('/api/entries/:id', requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const existing = db.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const body = JSON.parse(req.body.data || '{}');
    const { title, author, year, language, category, summary, note, tags, cover_svg } = body;

    let pdf_key      = existing.pdf_key;
    let pdf_url      = existing.pdf_url;
    let pdf_filename = existing.pdf_filename;

    if (req.file) {
      // Delete old PDF from R2 if present
      if (existing.pdf_key) await deletePDF(existing.pdf_key).catch(() => {});
      const result = await uploadPDF(req.file.buffer, req.file.originalname);
      pdf_key      = result.key;
      pdf_url      = result.url;
      pdf_filename = result.filename;
    }

    const cat = CATEGORIES.find(c => c.id === category) || CATEGORIES[1];

    const updated = db.update({
      ...existing,
      title,
      author:    author    || existing.author,
      year:      year      || existing.year,
      language:  language  || existing.language,
      category:  cat.id,
      summary:   summary   ?? existing.summary,
      note:      note      ?? existing.note,
      tags:      Array.isArray(tags) ? tags : existing.tags,
      cover_svg: cover_svg || existing.cover_svg,
      pdf_key,
      pdf_url,
      pdf_filename,
    });

    res.json(updated);
  } catch (err) {
    console.error('[PUT /api/entries/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete entry (soft delete — keeps record, marks hidden)
app.delete('/api/entries/:id', requireAdmin, async (req, res) => {
  try {
    const entry = db.getById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });

    // Only hard-delete PDF from R2 for non-seed entries
    if (!entry.is_seed && entry.pdf_key) {
      await deletePDF(entry.pdf_key).catch(() => {});
    }

    db.delete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/entries/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── AI PROCESSING ─────────────────────────────────────────────────────────

// Process a PDF — called before saving, returns AI-generated metadata
app.post('/api/process', requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided.' });

    const { title, author, year, language } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });

    const pdfBase64 = req.file.buffer.toString('base64');

    const result = await processBook({
      pdfBase64, title, author, year, language, apiKey,
    });

    res.json(result);
  } catch (err) {
    console.error('[POST /api/process]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SPA FALLBACK ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────
runSeeds();

app.listen(PORT, () => {
  console.log(`Archivum Universale running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
