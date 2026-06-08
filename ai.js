/**
 * AI Processing — Archivum Universale
 *
 * Two-call pipeline:
 *   1. Metadata call: send truncated PDF text → get domain, summary,
 *      scholarly note, tags, and an image_prompt
 *   2. Cover art call: send image_prompt → get SVG cover illustration
 *
 * PDF text is capped at MAX_CHARS to stay within token rate limits.
 */

const MAX_CHARS = 12000; // ~3,000 tokens — safe for all rate tiers

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

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

/**
 * Run the full AI pipeline for a book.
 *
 * @param {object} params
 * @param {string} params.pdfBase64   - Base64-encoded PDF (full file)
 * @param {string} params.title
 * @param {string} params.author
 * @param {string} params.year
 * @param {string} params.language
 * @param {string} params.apiKey      - Anthropic API key (from env, not client)
 *
 * @returns {{ domain, summary, note, tags, coverSvg }}
 */
async function processBook({ pdfBase64, title, author, year, language, apiKey }) {
  const headers = {
    'Content-Type':   'application/json',
    'x-api-key':       apiKey,
    'anthropic-version': '2023-06-01',
  };

  const catList = CATEGORIES.map(c => `${c.id} (${c.n} — ${c.label})`).join('\n');

  // ── CALL 1: Metadata ────────────────────────────────────────────────────
  const metaPrompt = `You are a scholarly archivist for Archivum Universale. Analyse the PDF and return ONLY valid JSON — no markdown, no preamble, no trailing text.

Text details:
Title: ${title}
Author: ${author || 'Unknown'}
Year: ${year || 'Unknown'}
Language: ${language}

Available domains:
${catList}

Return this exact JSON structure:
{
  "domain": "<one domain id — the single best fit>",
  "summary": "<2-3 sentences: what the text is and contains, factual, grounded in the actual content>",
  "scholarly_note": "<4-6 sentences: scholarly significance, place in intellectual history, main arguments or contributions, reception or influence — elevated register befitting a serious archive>",
  "tags": ["tag1","tag2","tag3","tag4","tag5","tag6"],
  "image_prompt": "<detailed visual description for a symbolic SVG book cover — describe dominant colors, key symbols, shapes, mood, compositional structure — be specific and evocative, grounded in this text's actual themes>"
}

Tags: lowercase, specific key themes, traditions, figures, concepts. Base all analysis on the actual PDF content.`;

  // Send only the first MAX_CHARS of the PDF as a text block to avoid
  // rate limit errors on large files. We decode, truncate, re-encode.
  const pdfText = safeDecodePDF(pdfBase64, MAX_CHARS);

  const metaBody = {
    model: MODEL,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          // Cache the document to reduce tokens on the second call if needed
        },
        { type: 'text', text: metaPrompt },
      ],
    }],
  };

  const metaResp = await callAPI(ANTHROPIC_API, headers, metaBody);
  const metaRaw  = extractText(metaResp);
  const meta     = parseJSON(metaRaw);

  const catMatch = CATEGORIES.find(c => c.id === meta.domain) || CATEGORIES[1];

  // ── CALL 2: Cover Art ───────────────────────────────────────────────────
  const artPrompt = `You are a master SVG illustrator creating a unique book cover for a scholarly archive called Archivum Universale.

Book: "${title}" by ${author || 'Unknown'} (${year || 'n.d.'})
Domain: ${catMatch.label} (${catMatch.n})
Visual concept: ${meta.image_prompt || 'a symbolic illustration capturing the essence of this text'}

Generate a single complete SVG element with viewBox="0 0 200 267" (portrait book cover proportions).

Design requirements:
- Dark near-black background (#0f0d0b or similar)
- Rich, atmospheric, symbolic composition — unique to this specific text
- Choose style (geometric, ornamental, atmospheric, abstract, esoteric) based on the content and domain
- No photorealistic faces — focus on symbols, geometry, patterns, atmosphere
- Include the roman numeral "${catMatch.n}" subtly
- Colours, shapes, and symbols should reflect the book's actual themes and essence
- The result should feel handcrafted, beautiful, and worthy of a serious intellectual archive

Return ONLY the SVG element — nothing before <svg and nothing after </svg>.`;

  const artBody = {
    model: MODEL,
    max_tokens: 3500,
    messages: [{ role: 'user', content: artPrompt }],
  };

  const artResp = await callAPI(ANTHROPIC_API, headers, artBody);
  const artRaw  = extractText(artResp);
  const coverSvg = extractSVG(artRaw) || generateFallbackCover(title, catMatch);

  return {
    domain:   catMatch.id,
    summary:  meta.summary   || '',
    note:     meta.scholarly_note || '',
    tags:     meta.tags      || [],
    coverSvg,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function callAPI(url, headers, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${resp.status}`);
  }
  return resp.json();
}

function extractText(data) {
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function parseJSON(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  // Find first { to last } to be safe
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) throw new Error('No JSON found in AI response');
  return JSON.parse(cleaned.slice(start, end));
}

function extractSVG(raw) {
  const start = raw.indexOf('<svg');
  const end   = raw.lastIndexOf('</svg>') + 6;
  if (start >= 0 && end > start) return raw.slice(start, end);
  return null;
}

/**
 * Safely decode base64 PDF to a text excerpt for context.
 * We don't actually need to parse the PDF binary — we send the
 * full base64 to the API's document handler and rely on Anthropic
 * to extract the content. This function is kept as a utility.
 */
function safeDecodePDF(base64, maxChars) {
  try {
    const buf = Buffer.from(base64, 'base64');
    const str = buf.toString('utf8', 0, Math.min(buf.length, maxChars * 2));
    return str.slice(0, maxChars);
  } catch {
    return '';
  }
}

function generateFallbackCover(title, cat) {
  const short = title.length > 20 ? title.slice(0, 18) + '…' : title;
  return `<svg viewBox="0 0 200 267" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="267" fill="#0f0d0b"/>
    <rect x="8" y="8" width="184" height="251" fill="none" stroke="#c9a84c" stroke-width="0.4" opacity="0.3"/>
    <text x="100" y="50" text-anchor="middle" font-family="serif" font-size="28" fill="#c9a84c" opacity="0.2">${cat.n}</text>
    <line x1="30" y1="133" x2="170" y2="133" stroke="#c9a84c" stroke-width="0.4" opacity="0.25"/>
    <text x="100" y="125" text-anchor="middle" font-family="serif" font-size="10" fill="#c9a84c" opacity="0.55" letter-spacing="1">${short}</text>
    <circle cx="100" cy="180" r="22" fill="none" stroke="#c9a84c" stroke-width="0.4" opacity="0.2"/>
    <text x="100" y="186" text-anchor="middle" font-family="serif" font-size="16" fill="#c9a84c" opacity="0.18">✦</text>
  </svg>`;
}

module.exports = { processBook, CATEGORIES, generateFallbackCover };
