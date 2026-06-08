/**
 * AI Processing — Archivum Universale
 *
 * Full-book chunked pipeline:
 *   1. Split PDF base64 into overlapping text chunks
 *   2. Analyse each chunk independently (parallel where rate allows)
 *   3. Synthesise all chunk findings into final metadata
 *   4. Generate tailored SVG cover art from the synthesis
 */

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const MODEL          = 'claude-sonnet-4-5';
const CHUNK_CHARS    = 15000;   // characters per chunk (~3 750 tokens)
const CHUNK_OVERLAP  = 500;     // overlap between chunks to avoid boundary loss
const MAX_CHUNKS     = 20;      // safety ceiling — handles books up to ~300k chars
const CHUNK_DELAY_MS = 1200;    // pause between chunk calls to respect rate limits

const CATEGORIES = [
  { id: 'esotericism',     n: 'I',    label: 'Esotericism' },
  { id: 'philosophy',      n: 'II',   label: 'Philosophy' },
  { id: 'psychology',      n: 'III',  label: 'Psychology' },
  { id: 'religion',        n: 'IV',   label: 'Religion' },
  { id: 'social-sciences', n: 'V',    label: 'Social Sciences' },
  { id: 'arts',            n: 'VI',   label: 'Arts' },
  { id: 'natural-sciences',n: 'VII',  label: 'Natural Sciences' },
  { id: 'formal-sciences', n: 'VIII', label: 'Formal Sciences' },
  { id: 'applied-science', n: 'IX',   label: 'Applied Science' },
  { id: 'hct',             n: 'X',    label: 'History · Culture · Technology' },
];

const CAT_LIST = CATEGORIES.map(c => `${c.id} (${c.n} — ${c.label})`).join('\n');

/**
 * Main entry point.
 * @param {object} params
 * @param {string} params.pdfBase64
 * @param {string} params.title
 * @param {string} params.author
 * @param {string} params.year
 * @param {string} params.language
 * @param {string} params.apiKey
 * @param {function} params.onProgress   optional callback(step, total, message)
 * @returns {{ domain, summary, note, tags, coverSvg }}
 */
async function processBook({ pdfBase64, title, author, year, language, apiKey, onProgress }) {
  const progress = onProgress || (() => {});
  const headers  = makeHeaders(apiKey);
  const bookMeta = `Title: ${title}\nAuthor: ${author||'Unknown'}\nYear: ${year||'Unknown'}\nLanguage: ${language}`;

  // ── 1. Extract text from PDF base64 ──────────────────────────────────────
  progress(1, 5, 'Extracting text from PDF');
  const fullText = extractTextFromBase64(pdfBase64);
  const chunks   = splitIntoChunks(fullText, CHUNK_CHARS, CHUNK_OVERLAP, MAX_CHUNKS);
  console.log(`[ai] PDF extracted: ${fullText.length} chars → ${chunks.length} chunks`);

  // ── 2. Analyse each chunk ─────────────────────────────────────────────────
  progress(2, 5, `Analysing ${chunks.length} section${chunks.length > 1 ? 's' : ''} of the text`);
  const chunkResults = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await delay(CHUNK_DELAY_MS);
    console.log(`[ai] Analysing chunk ${i + 1}/${chunks.length}`);

    const prompt = `You are a scholarly archivist reading a section of a book for Archivum Universale.

${bookMeta}
Section ${i + 1} of ${chunks.length}.

TEXT EXCERPT:
${chunks[i]}

From this section, extract:
1. Key themes, arguments, concepts, or ideas present
2. Named figures, traditions, schools of thought, or disciplines referenced
3. The apparent nature and purpose of this section of the text

Return ONLY valid JSON, no markdown:
{
  "themes": ["theme1","theme2","theme3"],
  "figures": ["name1","name2"],
  "concepts": ["concept1","concept2","concept3"],
  "observations": "<2-3 sentences about what this section covers and its significance>"
}`;

    try {
      const resp   = await callAPI(ANTHROPIC_API, headers, { model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: prompt }] });
      const parsed = parseJSON(extractText(resp));
      chunkResults.push(parsed);
    } catch (err) {
      console.warn(`[ai] Chunk ${i+1} failed: ${err.message} — continuing`);
      chunkResults.push({ themes: [], figures: [], concepts: [], observations: '' });
    }
  }

  // ── 3. Synthesise all chunk findings ──────────────────────────────────────
  progress(3, 5, 'Synthesising full analysis');
  const synthesis = chunkResults.map((r, i) =>
    `Section ${i+1}: ${r.observations}\nThemes: ${(r.themes||[]).join(', ')}\nFigures: ${(r.figures||[]).join(', ')}\nConcepts: ${(r.concepts||[]).join(', ')}`
  ).join('\n\n');

  const synthPrompt = `You are the chief archivist of Archivum Universale. You have received analytical notes on every section of the following book.

${bookMeta}

SECTION ANALYSES:
${synthesis}

Based on the complete analysis of all sections, produce the definitive archival metadata for this work.

Available domains:
${CAT_LIST}

Return ONLY valid JSON, no markdown, no preamble:
{
  "domain": "<single best-fit domain id>",
  "summary": "<2-3 sentences: what this text is, what it contains, and why it matters — factual, grounded in the actual content>",
  "scholarly_note": "<4-6 sentences: scholarly significance, place in intellectual history, main arguments or contributions, reception or influence — elevated register befitting a serious archive>",
  "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8"],
  "image_prompt": "<detailed visual description for a symbolic SVG book cover — dominant colours, key symbols, shapes, compositional mood — specific and evocative, grounded in this text's actual themes>"
}

Tags: lowercase, specific — key themes, traditions, figures, concepts, disciplines found across the whole book.`;

  const synthResp   = await callAPI(ANTHROPIC_API, headers, { model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: synthPrompt }] });
  const meta        = parseJSON(extractText(synthResp));
  const catMatch    = CATEGORIES.find(c => c.id === meta.domain) || CATEGORIES[1];

  // ── 4. Generate cover art ─────────────────────────────────────────────────
  progress(4, 5, 'Generating tailored cover art');
  await delay(800);

  const artPrompt = `You are a master SVG illustrator creating a unique book cover for Archivum Universale, a scholarly archive of important texts.

Book: "${title}" by ${author||'Unknown'} (${year||'n.d.'})
Domain: ${catMatch.label} (${catMatch.n})
Visual concept: ${meta.image_prompt || 'a symbolic illustration capturing the essence of this text'}

Generate a single complete SVG element with viewBox="0 0 200 267".

Requirements:
- Dark near-black background (#0f0d0b or close variant)
- Rich, atmospheric, symbolic composition unique to this specific text
- Choose visual style (geometric, ornamental, atmospheric, esoteric, abstract) based on the content and domain
- No photorealistic faces — symbols, geometry, patterns, atmosphere
- Subtly include the roman numeral "${catMatch.n}"
- Colours and symbols must reflect the book's actual themes
- Beautiful, handcrafted feel worthy of a serious intellectual archive

Return ONLY the SVG element — nothing before <svg and nothing after </svg>.`;

  let coverSvg = generateFallbackCover(title, catMatch);
  try {
    const artResp = await callAPI(ANTHROPIC_API, headers, { model: MODEL, max_tokens: 3500, messages: [{ role: 'user', content: artPrompt }] });
    const artRaw  = extractText(artResp);
    coverSvg      = extractSVG(artRaw) || coverSvg;
  } catch (err) {
    console.warn('[ai] Cover art failed, using fallback:', err.message);
  }

  // ── 5. Done ───────────────────────────────────────────────────────────────
  progress(5, 5, 'Complete');

  return {
    domain:   catMatch.id,
    summary:  meta.summary || '',
    note:     meta.scholarly_note || '',
    tags:     meta.tags || [],
    coverSvg,
  };
}

// ── TEXT EXTRACTION ───────────────────────────────────────────────────────────
function extractTextFromBase64(base64) {
  try {
    const buf = Buffer.from(base64, 'base64');
    // Extract readable ASCII/UTF-8 strings from the PDF binary
    // This gives us the text content without a full PDF parser
    let text = '';
    const raw = buf.toString('binary');
    // Match runs of printable characters (PDF text streams)
    const matches = raw.match(/[\x20-\x7E\n\r\t]{4,}/g) || [];
    text = matches
      .filter(m => m.trim().length > 3)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Remove common PDF artefacts
    text = text
      .replace(/endobj|endstream|xref|startxref|trailer|%%EOF/g, ' ')
      .replace(/obj\s*<<[^>]*>>/g, ' ')
      .replace(/\/(Type|Font|Page|Resources|MediaBox|Contents|Kids|Count|Parent)\b/g, ' ')
      .replace(/\s{3,}/g, '  ')
      .trim();
    return text;
  } catch (err) {
    console.warn('[ai] Text extraction failed:', err.message);
    return '';
  }
}

function splitIntoChunks(text, chunkSize, overlap, maxChunks) {
  if (!text || text.length === 0) return ['[No extractable text found in PDF]'];
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length) break;
  }
  return chunks.length > 0 ? chunks : [text.slice(0, chunkSize)];
}

// ── API HELPERS ───────────────────────────────────────────────────────────────
function makeHeaders(apiKey) {
  return {
    'Content-Type':    'application/json',
    'x-api-key':        apiKey,
    'anthropic-version':'2023-06-01',
  };
}

async function callAPI(url, headers, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (resp.status === 429) {
        // Rate limited — wait and retry with exponential backoff
        const wait = attempt * 3000;
        console.warn(`[ai] Rate limited, waiting ${wait}ms (attempt ${attempt}/${retries})`);
        await delay(wait);
        continue;
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err?.error?.message || `API error ${resp.status}`);
      }
      return resp.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await delay(attempt * 2000);
    }
  }
}

function extractText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

function parseJSON(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start   = cleaned.indexOf('{');
  const end     = cleaned.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) throw new Error('No JSON in AI response');
  return JSON.parse(cleaned.slice(start, end));
}

function extractSVG(raw) {
  const start = raw.indexOf('<svg');
  const end   = raw.lastIndexOf('</svg>') + 6;
  if (start >= 0 && end > start) return raw.slice(start, end);
  return null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateFallbackCover(title, cat) {
  const short = (title||'').length > 18 ? title.slice(0,16)+'…' : (title||'');
  return `<svg viewBox="0 0 200 267" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="267" fill="#0f0d0b"/>
    <rect x="8" y="8" width="184" height="251" fill="none" stroke="#c9a84c" stroke-width="0.4" opacity="0.3"/>
    <text x="100" y="55" text-anchor="middle" font-family="serif" font-size="26" fill="#c9a84c" opacity="0.18">${cat?.n||''}</text>
    <line x1="30" y1="133" x2="170" y2="133" stroke="#c9a84c" stroke-width="0.4" opacity="0.22"/>
    <text x="100" y="125" text-anchor="middle" font-family="serif" font-size="10" fill="#c9a84c" opacity="0.5" letter-spacing="1">${short}</text>
    <circle cx="100" cy="185" r="20" fill="none" stroke="#c9a84c" stroke-width="0.4" opacity="0.18"/>
    <text x="100" y="191" text-anchor="middle" font-family="serif" font-size="14" fill="#c9a84c" opacity="0.15">✦</text>
  </svg>`;
}

module.exports = { processBook, CATEGORIES, generateFallbackCover };
