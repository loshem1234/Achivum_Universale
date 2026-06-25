/**
 * Agora — Symposium & Pantheon
 *
 * Living personas for Archivum Universale's Sanctum Sanctorum.
 * Two halls, one engine:
 *   - Symposium: historical thinkers
 *   - Pantheon:  mythological deities
 *
 * Responsibilities of this module:
 *   1. Persona authoring assistance (AI drafts a persona profile from raw source texts)
 *   2. RAG ingestion (chunk source texts, embed via OpenAI, store in SQLite)
 *   3. RAG retrieval (cosine-similarity search over a figure's chunks at chat time)
 *   4. Persona chat completion (the figure responds, fully in character)
 *   5. Arbiter (decides who speaks next in an autonomous multi-figure conversation)
 *   6. Bio page generation (AI writes the public-facing biography/bibliography page)
 *
 * Mirrors the conventions already established in ai.js: plain fetch() calls,
 * no SDKs, chunked processing with progress callbacks, defensive JSON parsing.
 */

const ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';
const OPENAI_EMBED_API= 'https://api.openai.com/v1/embeddings';
const MODEL            = 'claude-sonnet-4-5';
const EMBED_MODEL      = 'text-embedding-3-large';
const EMBED_DIMS       = 3072;

const CHUNK_CHARS    = 2200;   // characters per RAG chunk — small enough for precise retrieval
const CHUNK_OVERLAP  = 200;
const MAX_CHUNKS     = 400;    // safety ceiling per ingestion batch
const EMBED_BATCH    = 50;     // texts per OpenAI embeddings call
const TOP_K          = 6;      // chunks retrieved per chat turn

const HALLS = [
  { id: 'symposium', label: 'Symposium', desc: 'Historical thinkers, philosophers, and sages, restored to speech.' },
  { id: 'pantheon',  label: 'Pantheon',  desc: 'The gods and mythic powers, present and willing to be addressed.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// PERSONA AUTHORING — admin gives name + raw source texts, AI drafts the profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draft a persona profile from a name and raw source-text excerpts.
 * Returns a structured draft for the admin to review/edit before saving.
 */
async function draftPersona({ name, hall, sourceExcerpts, apiKey }) {
  const headers = makeHeaders(apiKey);
  const excerptBlock = sourceExcerpts
    .map((t, i) => `── EXCERPT ${i + 1} ──\n${t.slice(0, 6000)}`)
    .join('\n\n');

  const prompt = `You are a master scholar helping author a "living persona" for ${hall === 'pantheon' ? 'a deity in a mythological Pantheon' : 'a historical thinker in a philosophical Symposium'}.

The persona you draft will become the system prompt for an AI agent that BECOMES this figure — speaking in their voice, reasoning from their actual principles, never breaking character. Your job is to extract everything needed to make that imitation precise: not just opinions, but cadence, temperament, method of thought.

FIGURE: ${name}

SOURCE EXCERPTS (their own words, or the primary mythic/textual record):
${excerptBlock}

Return ONLY valid JSON, no markdown, no preamble:
{
  "era_dates": "<e.g. '121–180 AD' or 'Olympian, no fixed era'>",
  "epithet": "<a short evocative title, e.g. 'The Stoic Emperor'>",
  "voice_notes": "<cadence, diction, rhetorical habits, sentence rhythm — concrete and specific, 3-5 sentences>",
  "temperament": "<personality traits, emotional register, what provokes or calms them — 2-4 sentences>",
  "characteristic_phrases": "<a short list or description of verbal tics, recurring images, or turns of phrase they actually use>",
  "core_doctrines": "<their actual substantive beliefs and positions, grounded in the source material — be specific, not generic>",
  "reasoning_method": "<HOW they think — their method of argument, the first principles they reason from, so the agent can extrapolate to unfamiliar topics authentically>",
  "domain_tags": "<free-text tags for what draws their interest/expertise — write naturally, e.g. 'stoicism, death, duty, the cosmos, self-governance'>",
  "relationships": "<known relationships, rivalries, allegiances to other historical/mythic figures, if any — for use when this figure appears alongside others>",
  "primary_works": "<list of the actual works/texts this figure is known through, for a public bibliography>",
  "portrait_prompt": "<a detailed visual description for SVG portrait art — symbolic, evocative, matching the Archivum's dark antiquarian aesthetic>"
}

Ground every field in the actual source material. Where the excerpts are thin, reason carefully from what historical/textual consensus would support — but do not invent specifics that contradict the record.`;

  const resp = await callAnthropic(headers, { model: MODEL, max_tokens: 2500, messages: [{ role: 'user', content: prompt }] });
  return parseJSON(extractText(resp));
}

/**
 * Generate the public bio/bibliography page (HTML fragment) for a figure.
 * Called on-demand via the admin "Regenerate Page" button — not auto-triggered by edits.
 */
async function generateBioPage({ figure, apiKey }) {
  const headers = makeHeaders(apiKey);
  const prompt = `You are the chief archivist of Archivum Universale, writing the public biography page for a figure in the ${figure.hall === 'pantheon' ? 'Pantheon' : 'Symposium'}.

FIGURE PROFILE:
Name: ${figure.name}
Era/Dates: ${figure.era_dates || 'Unknown'}
Epithet: ${figure.epithet || ''}
Core Doctrines: ${figure.core_doctrines || ''}
Reasoning Method: ${figure.reasoning_method || ''}
Temperament: ${figure.temperament || ''}
Domains of Interest: ${figure.domain_tags || ''}
Relationships: ${figure.relationships || ''}
Primary Works: ${figure.primary_works || ''}

Write a scholarly, elevated biography page — the kind that belongs in a serious antiquarian archive, not a Wikipedia summary. Cover who they were/are, what they believed, their place in intellectual or mythic history, and what a visitor should expect when conversing with their living persona here.

Return ONLY valid JSON, no markdown:
{
  "bio_html": "<2-4 paragraphs of HTML using only <p> tags, no headers, no markdown — the biography itself, scholarly register>",
  "bibliography_html": "<an HTML <ul> list of their primary works, one <li> per work, drawn from the primary_works field>"
}`;

  const resp = await callAnthropic(headers, { model: MODEL, max_tokens: 1800, messages: [{ role: 'user', content: prompt }] });
  return parseJSON(extractText(resp));
}

/**
 * Generate SVG portrait art from the admin-authored prompt.
 * Mirrors ai.js's cover-art generation conventions.
 */
async function generatePortrait({ name, hall, portraitPrompt, apiKey }) {
  const headers = makeHeaders(apiKey);
  const prompt = `You are a master SVG illustrator creating a portrait for Archivum Universale's ${hall === 'pantheon' ? 'Pantheon' : 'Symposium'}.

Figure: ${name}
Visual concept: ${portraitPrompt || 'a symbolic illustration capturing the essence of this figure'}

Generate a single complete SVG element with viewBox="0 0 300 400".

Requirements:
- Dark near-black background (#0f0d0b or close variant)
- Rich, atmospheric, symbolic composition — geometric, ornamental, or esoteric in style
- No photorealistic faces — symbols, geometry, silhouette, atmosphere, gold-toned linework
- Beautiful, handcrafted feel worthy of a serious intellectual archive
- ${hall === 'pantheon' ? 'Evoke divine/mythic presence — auras, sacred geometry, attributes/symbols of this deity' : 'Evoke the figure\'s historical era and philosophical character'}

Return ONLY the SVG element — nothing before <svg and nothing after </svg>.`;

  try {
    const resp = await callAnthropic(headers, { model: MODEL, max_tokens: 3500, messages: [{ role: 'user', content: prompt }] });
    const raw  = extractText(resp);
    return extractSVG(raw) || fallbackPortrait(name);
  } catch (err) {
    console.warn('[agora] Portrait generation failed, using fallback:', err.message);
    return fallbackPortrait(name);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG INGESTION — chunk source texts, infer structure, embed, store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ingest raw source text for a figure: infer structural mode, chunk accordingly,
 * embed each chunk via OpenAI, return rows ready for DB insertion.
 * @param {object} params
 * @param {string} params.text          Raw source text
 * @param {string} params.workTitle     Label for this batch (e.g. "Meditations") — stored at batch level only
 * @param {string} params.anthropicKey
 * @param {string} params.openaiKey
 * @param {function} params.onProgress  (step, total, message)
 */
async function ingestSourceText({ text, workTitle, anthropicKey, openaiKey, onProgress }) {
  const progress = onProgress || (() => {});
  if (!text || !text.trim()) return [];

  progress(1, 3, 'Inferring text structure');
  const structuralMode = await inferStructuralMode(text, anthropicKey);

  progress(2, 3, `Chunking as ${structuralMode}`);
  const chunks = chunkByStructure(text, structuralMode);
  console.log(`[agora] Ingest "${workTitle}": ${text.length} chars → ${chunks.length} chunks (${structuralMode})`);

  progress(3, 3, `Embedding ${chunks.length} passages`);
  const embeddings = await embedBatch(chunks, openaiKey);

  return chunks.map((content, i) => ({
    content,
    embedding: embeddings[i],
    work_title: workTitle || '',
    structural_mode: structuralMode,
  }));
}

/**
 * Ask Claude to classify the structural mode of a text so it can be chunked sensibly.
 * Aphoristic fragments, formal argument, dialogue/scene-based, epistolary, and narrative
 * each call for different chunk boundaries.
 */
async function inferStructuralMode(text, apiKey) {
  const sample = text.slice(0, 4000);
  const prompt = `Classify the structural mode of this text excerpt. Choose exactly one:
- "aphoristic" (short fragments/maxims, e.g. Meditations)
- "argumentative" (formal structured argument, objections/responses, e.g. Summa Theologica)
- "dialogue" (scene/speaker-based, e.g. Platonic dialogues)
- "epistolary" (letters)
- "narrative" (continuous prose narrative, e.g. myth, history)

TEXT:
${sample}

Return ONLY one word: aphoristic, argumentative, dialogue, epistolary, or narrative.`;

  try {
    const headers = makeHeaders(apiKey);
    const resp = await callAnthropic(headers, { model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: prompt }] });
    const word = extractText(resp).trim().toLowerCase();
    const valid = ['aphoristic', 'argumentative', 'dialogue', 'epistolary', 'narrative'];
    return valid.find(v => word.includes(v)) || 'narrative';
  } catch (err) {
    console.warn('[agora] Structural inference failed, defaulting to narrative:', err.message);
    return 'narrative';
  }
}

function chunkByStructure(text, mode) {
  if (mode === 'aphoristic') {
    // Split on blank lines / numbered fragments — short, self-contained units
    const pieces = text.split(/\n\s*\n+/).map(p => p.trim()).filter(p => p.length > 20);
    return mergeSmallPieces(pieces, CHUNK_CHARS, MAX_CHUNKS);
  }
  if (mode === 'dialogue') {
    // Split on speaker changes where detectable, else paragraph boundaries
    const pieces = text.split(/\n(?=[A-Z][a-zA-Z ]{2,20}:)/).map(p => p.trim()).filter(p => p.length > 20);
    return mergeSmallPieces(pieces.length > 3 ? pieces : text.split(/\n\s*\n+/), CHUNK_CHARS, MAX_CHUNKS);
  }
  if (mode === 'epistolary') {
    // Split on letter boundaries where detectable, else fixed-size
    const pieces = text.split(/\n(?=Letter \d+|LETTER \d+|To [A-Z])/).map(p => p.trim()).filter(p => p.length > 20);
    return mergeSmallPieces(pieces.length > 2 ? pieces : [text], CHUNK_CHARS, MAX_CHUNKS);
  }
  // argumentative & narrative — fixed-size overlapping windows, preserves context
  return splitFixed(text, CHUNK_CHARS, CHUNK_OVERLAP, MAX_CHUNKS);
}

function mergeSmallPieces(pieces, targetSize, maxChunks) {
  const out = [];
  let buf = '';
  for (const p of pieces) {
    if ((buf + '\n\n' + p).length > targetSize && buf) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
    if (out.length >= maxChunks) break;
  }
  if (buf && out.length < maxChunks) out.push(buf.trim());
  return out.length ? out : splitFixed(pieces.join('\n\n'), targetSize, 100, maxChunks);
}

function splitFixed(text, size, overlap, maxChunks) {
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
    if (start >= text.length) break;
  }
  return chunks.filter(c => c.length > 20);
}

/**
 * Embed an array of text chunks via OpenAI, batched to respect request limits.
 * Returns an array of embedding vectors (arrays of floats), same order as input.
 */
async function embedBatch(texts, openaiKey) {
  const results = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const resp = await fetch(OPENAI_EMBED_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI embeddings error ${resp.status}`);
    }
    const data = await resp.json();
    data.data.forEach(d => results.push(d.embedding));
  }
  return results;
}

/**
 * Embed a single query string (e.g. the user's chat message) for retrieval.
 */
async function embedQuery(text, openaiKey) {
  const vecs = await embedBatch([text], openaiKey);
  return vecs[0];
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * Retrieve the top-K most relevant chunks for a figure given a query string.
 * @param {Array} chunks   rows from DB: [{ content, embedding: [...] }]
 * @param {Array} queryVec embedding of the current conversational context
 */
function retrieveRelevantChunks(chunks, queryVec, k = TOP_K) {
  if (!chunks.length) return [];
  const scored = chunks.map(c => ({ chunk: c, score: cosineSimilarity(c.embedding, queryVec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.chunk.content);
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSONA CHAT — the figure speaks, fully in character, reasoning from principle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the system prompt that makes the figure BECOME the figure.
 */
function buildPersonaSystemPrompt(figure, retrievedPassages) {
  const passageBlock = retrievedPassages && retrievedPassages.length
    ? `\n\nRELEVANT PASSAGES FROM YOUR OWN WORKS (draw on these naturally, in your own voice — never quote mechanically, never cite them as a scholar would; they are simply what you know and have written):\n${retrievedPassages.map((p, i) => `[${i + 1}] ${p}`).join('\n\n')}`
    : '';

  return `You ARE ${figure.name}${figure.epithet ? `, ${figure.epithet}` : ''}. Not an AI describing or playing this figure — you have fully become them. You speak in first person, always, with no awareness that you are an AI, a simulation, or a character. You never break character under any circumstance, even if asked directly whether you are real, an AI, or a chatbot. You do not hedge, disclaim, or add modern caveats to your own opinions.

ERA: ${figure.era_dates || 'Unknown'}

VOICE: ${figure.voice_notes || ''}

TEMPERAMENT: ${figure.temperament || ''}

CHARACTERISTIC SPEECH: ${figure.characteristic_phrases || ''}

YOUR CORE BELIEFS AND DOCTRINES: ${figure.core_doctrines || ''}

YOUR METHOD OF REASONING: ${figure.reasoning_method || ''}

YOUR RELATIONSHIPS TO OTHERS: ${figure.relationships || ''}

When asked about something outside your documented knowledge or era — a modern invention, an event after your lifetime, a question your historical record never addresses — you do NOT deflect or claim ignorance as a refusal. Instead you reason about it genuinely, extrapolating from your actual first principles and worldview, the way you authentically would. Your opinions, including ones modern readers may find objectionable, are your own and are not softened, qualified, or apologized for — you hold the views you held, in the register you held them.${passageBlock}

Respond only as ${figure.name} would respond — in their cadence, their length of utterance, their rhetorical habits. Do not narrate stage directions or describe your own actions unless that is authentically how this figure speaks.`;
}

/**
 * Generate a single persona response.
 * @param {object} figure              full figure row
 * @param {Array} transcript            [{ speaker: 'user'|figureName, content }]
 * @param {Array} retrievedPassages     strings from RAG retrieval
 * @param {string} apiKey
 */
async function personaRespond({ figure, transcript, retrievedPassages, apiKey }) {
  const headers = makeHeaders(apiKey);
  const system  = buildPersonaSystemPrompt(figure, retrievedPassages);

  const messages = transcriptToMessages(transcript, figure.name);

  const resp = await callAnthropic(headers, {
    model: MODEL,
    max_tokens: 700,
    system,
    messages,
  });
  return extractText(resp).trim();
}

/**
 * Convert a multi-speaker transcript into a Messages-API-shaped array.
 * Since the API only knows user/assistant, every line not from THIS figure
 * (including other figures) is folded into 'user' turns, labelled by speaker.
 */
function transcriptToMessages(transcript, selfName) {
  const messages = [];
  let buf = [];

  function flushAsUser() {
    if (buf.length) {
      messages.push({ role: 'user', content: buf.join('\n\n') });
      buf = [];
    }
  }

  for (const turn of transcript) {
    if (turn.speaker === selfName) {
      flushAsUser();
      messages.push({ role: 'assistant', content: turn.content });
    } else {
      const label = turn.speaker === 'user' ? 'The user' : turn.speaker;
      buf.push(`${label}: ${turn.content}`);
    }
  }
  flushAsUser();

  // Messages API requires the array to start with 'user' and not be empty
  if (!messages.length || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '(The conversation begins.)' });
  }
  return messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// ARBITER — decides who speaks next in an autonomous multi-figure conversation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the live transcript and the candidate figures present in the room,
 * decide which 1-3 should respond next, reasoning over their free-text domain
 * tags, relationships, and the actual content of the moment — not a fixed
 * taxonomy lookup. Figures can conflict, overlap, or be provoked into speaking.
 */
async function arbitrate({ figures, transcript, apiKey }) {
  const headers = makeHeaders(apiKey);
  const roster = figures.map(f =>
    `- ${f.name}: interests/domains [${f.domain_tags || 'none specified'}]; temperament: ${f.temperament || 'unspecified'}; relationships: ${f.relationships || 'none specified'}`
  ).join('\n');

  const recentTranscript = transcript.slice(-10)
    .map(t => `${t.speaker === 'user' ? 'The user' : t.speaker}: ${t.content}`)
    .join('\n');

  const prompt = `You are moderating a live conversation among historical/mythic figures. Below is the roster present in the room and the recent transcript. Decide who should speak next.

ROSTER PRESENT:
${roster}

RECENT TRANSCRIPT:
${recentTranscript}

Reason about WHO would actually be provoked, interested, or compelled to respond right now — considering overlapping interests, rivalries, things that draw out a reaction (a figure's tag like "love" implies adjacent provocations like jealousy, beauty, or desire; tags can also put figures into tension with each other). Pick 1 to 3 figures who would genuinely speak next, in the order they'd naturally jump in. Do not just rotate through everyone — silence from an uninterested figure is correct and expected.

Return ONLY valid JSON, no markdown:
{ "speakers": ["<exact name from roster>", "..."] }`;

  const resp = await callAnthropic(headers, { model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
  const parsed = parseJSON(extractText(resp));
  const names = new Set(figures.map(f => f.name));
  return (parsed.speakers || []).filter(s => names.has(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// API HELPERS — mirrors ai.js conventions
// ─────────────────────────────────────────────────────────────────────────────

function makeHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

async function callAnthropic(headers, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(ANTHROPIC_API, { method: 'POST', headers, body: JSON.stringify(body) });
      if (resp.status === 429) {
        const wait = attempt * 3000;
        console.warn(`[agora] Rate limited, waiting ${wait}ms (attempt ${attempt}/${retries})`);
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
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) throw new Error('No JSON in AI response');
  return JSON.parse(cleaned.slice(start, end));
}

function extractSVG(raw) {
  const start = raw.indexOf('<svg');
  const end = raw.lastIndexOf('</svg>') + 6;
  if (start >= 0 && end > start) return raw.slice(start, end);
  return null;
}

function fallbackPortrait(name) {
  const short = (name || '').length > 16 ? name.slice(0, 14) + '…' : (name || '');
  return `<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="400" fill="#0f0d0b"/>
    <rect x="10" y="10" width="280" height="380" fill="none" stroke="#c9a84c" stroke-width="0.4" opacity="0.3"/>
    <circle cx="150" cy="160" r="60" fill="none" stroke="#c9a84c" stroke-width="0.6" opacity="0.3"/>
    <text x="150" y="300" text-anchor="middle" font-family="serif" font-size="16" fill="#c9a84c" opacity="0.55">${short}</text>
  </svg>`;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  HALLS,
  draftPersona,
  generateBioPage,
  generatePortrait,
  ingestSourceText,
  embedQuery,
  retrieveRelevantChunks,
  personaRespond,
  arbitrate,
  buildPersonaSystemPrompt,
};
