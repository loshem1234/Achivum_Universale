/**
 * Seeds the database with the 14 canonical Archivum Universale texts.
 * Runs once on server start — skips entries that already exist.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const { generateFallbackCover } = require('./ai');

const CATEGORIES = [
  { id: 'esotericism',     n: 'I'    },
  { id: 'philosophy',      n: 'II'   },
  { id: 'psychology',      n: 'III'  },
  { id: 'religion',        n: 'IV'   },
  { id: 'social-sciences', n: 'V'    },
  { id: 'arts',            n: 'VI'   },
  { id: 'natural-sciences',n: 'VII'  },
  { id: 'formal-sciences', n: 'VIII' },
  { id: 'applied-science', n: 'IX'   },
  { id: 'hct',             n: 'X'    },
];

const SEED_ENTRIES = [
  { title: 'The Kybalion', author: 'Three Initiates', year: '1908', language: 'English', category: 'esotericism',
    summary: 'A concise presentation of the seven Hermetic principles underlying all of nature, drawing on the philosophical tradition of Hermes Trismegistus.',
    note: 'One of the most widely read introductions to occult philosophy in the modern era, the Kybalion distills a system of mental cosmology wherein everything is mental in nature. Its seven principles — mentalism, correspondence, vibration, polarity, rhythm, cause and effect, and gender — constitute a complete ontological framework that has influenced esoteric thought throughout the twentieth century.',
    tags: ['hermeticism', 'occult philosophy', 'initiation', 'mental cosmology'] },

  { title: 'Isis Unveiled', author: 'H.P. Blavatsky', year: '1877', language: 'English', category: 'esotericism',
    summary: 'Blavatsky\'s landmark two-volume work proposing that a single ancient wisdom tradition underlies all religion, science, and philosophy.',
    note: 'A foundational text of the modern Theosophical movement, Isis Unveiled challenged the materialist consensus of Victorian science and the exclusionary claims of institutional religion alike. Blavatsky marshals enormous comparative scholarship in service of the perennial philosophy, arguing that modern science and orthodox religion have both lost contact with the primordial wisdom preserved in esoteric traditions.',
    tags: ['theosophy', 'ancient wisdom', 'comparative religion', 'perennial philosophy'] },

  { title: 'Critique of Pure Reason', author: 'Immanuel Kant', year: '1781', language: 'German', category: 'philosophy',
    summary: 'Kant\'s landmark examination of the foundations and limits of human knowledge, arguing that the structure of the mind itself shapes our experience of reality.',
    note: 'The first Critique inaugurated the Copernican revolution in philosophy, establishing that space, time, and causality are forms of human intuition rather than features of things-in-themselves. The cornerstone of German Idealism and modern epistemology, it permanently transformed the terms of philosophical inquiry and inaugurated a tradition that runs through Fichte, Schelling, and Hegel to the present.',
    tags: ['epistemology', 'idealism', 'metaphysics', 'transcendental philosophy'] },

  { title: 'Being and Time', author: 'Martin Heidegger', year: '1927', language: 'German', category: 'philosophy',
    summary: 'A fundamental ontological analysis of the nature of being as disclosed through the structure of human existence.',
    note: 'Heidegger\'s analysis of Dasein — being-in-the-world, care, thrownness, and being-toward-death — permanently reshaped continental philosophy and influenced fields from theology to architectural theory. The work\'s relentless questioning of the Western metaphysical tradition and its recovery of the question of Being from centuries of forgetfulness make it among the most demanding and rewarding texts of the twentieth century.',
    tags: ['ontology', 'phenomenology', 'existentialism', 'Dasein'] },

  { title: 'The Republic', author: 'Plato', year: '~375 BC', language: 'Greek', category: 'philosophy',
    summary: 'Socratic dialogues on justice, the nature of the soul, the ideal city-state, and the philosopher-king.',
    note: 'Containing the allegory of the cave, the theory of Forms, and one of antiquity\'s most enduring visions of the good society, the Republic remains the central document of political philosophy and a founding text of Western metaphysics. Its tripartite psychology, its critique of democracy, and its vision of philosophy as the highest human vocation have generated commentary and controversy for two and a half millennia.',
    tags: ['political philosophy', 'ethics', 'metaphysics', 'allegory of the cave'] },

  { title: 'Thus Spoke Zarathustra', author: 'Friedrich Nietzsche', year: '1883', language: 'German', category: 'philosophy',
    summary: 'Nietzsche\'s philosophical prose-poem on the death of God, the will to power, the Übermensch, and eternal recurrence.',
    note: 'Written in prophetic and literary style, Zarathustra announces the revaluation of all values and the figure of the Übermensch as humanity\'s self-surpassing ideal. Nietzsche\'s doctrine of eternal recurrence — that one must affirm life as it is unconditionally — represents one of the most demanding ethical challenges in the Western tradition. Among the most provocative and persistently misread works in the philosophical canon.',
    tags: ['existentialism', 'will to power', 'eternal recurrence', 'nihilism'] },

  { title: 'The Interpretation of Dreams', author: 'Sigmund Freud', year: '1899', language: 'German', category: 'psychology',
    summary: 'The foundational text of psychoanalysis, arguing that dreams are the royal road to the unconscious mind.',
    note: 'Freud\'s first comprehensive model of the psyche emerges here: the primary process, wish-fulfillment, condensation, displacement, and the dream-work. The book launched not only a clinical method but a whole new hermeneutics of human culture, opening interpretation as a discipline to the previously inaccessible realm of unconscious desire and symbol.',
    tags: ['psychoanalysis', 'unconscious', 'dreams', 'wish-fulfillment'] },

  { title: 'Man and His Symbols', author: 'Carl G. Jung', year: '1964', language: 'English', category: 'psychology',
    summary: 'Jung\'s final and most accessible work, explaining the role of symbolic imagery in the unconscious and the individuation process.',
    note: 'Conceived as an introduction to analytical psychology for a general audience, the book presents the theory of archetypes, the collective unconscious, and symbolic meaning as forces active in dreams, art, and cultural life. Written in the final years of Jung\'s life with characteristic breadth, it remains the best single-volume entry point to a body of thought that rivals Freud in its influence on twentieth-century culture.',
    tags: ['analytical psychology', 'archetypes', 'symbolism', 'individuation'] },

  { title: 'The Varieties of Religious Experience', author: 'William James', year: '1902', language: 'English', category: 'religion',
    summary: 'A landmark examination of mystical experience, conversion, and faith through a pragmatist philosophical lens.',
    note: 'James\'s Gifford Lectures remain the foundational text in the psychology of religion and the philosophy of mysticism. His empirical, non-reductive approach to spiritual states — treating them as facts of experience warranting serious inquiry rather than theological claims to be accepted or dismissed — opened the field of religious studies to rigorous philosophical investigation.',
    tags: ['mysticism', 'pragmatism', 'phenomenology of religion', 'conversion'] },

  { title: 'The Structure of Scientific Revolutions', author: 'Thomas S. Kuhn', year: '1962', language: 'English', category: 'social-sciences',
    summary: 'Kuhn\'s argument that science advances through discontinuous paradigm shifts rather than linear accumulation of knowledge.',
    note: 'One of the most cited academic works of the twentieth century, Kuhn\'s analysis of normal science, anomaly, and revolutionary change transformed both the philosophy of science and the self-understanding of scientific communities. The concept of the paradigm — the shared constellation of beliefs, values, and techniques that defines a scientific community — has become indispensable to intellectual discourse across disciplines.',
    tags: ['philosophy of science', 'paradigm shift', 'epistemology', 'scientific revolution'] },

  { title: 'Poetics', author: 'Aristotle', year: '~335 BC', language: 'Greek', category: 'arts',
    summary: 'Aristotle\'s foundational treatise on dramatic poetry, defining tragedy, catharsis, mimesis, and the formal elements of narrative.',
    note: 'The starting point of all subsequent Western literary criticism, the Poetics establishes mimesis as the foundation of art, analyzes the structure of tragic narrative into its formal elements — plot, character, diction, thought, spectacle, song — and introduces catharsis as the distinctive emotional function of tragedy. Its influence on drama, narrative theory, and aesthetics across two and a half millennia is without parallel.',
    tags: ['aesthetics', 'tragedy', 'literary theory', 'mimesis', 'catharsis'] },

  { title: 'Principia Mathematica', author: 'Isaac Newton', year: '1687', language: 'Latin', category: 'natural-sciences',
    summary: 'Newton\'s definitive statement of classical mechanics, the laws of motion, and universal gravitation.',
    note: 'The exemplary achievement of the Scientific Revolution, the Principia synthesized terrestrial and celestial mechanics into a single mathematical framework and established the model of axiomatic natural philosophy that governed physics for two centuries. Few books have so decisively and permanently reshaped the human understanding of the natural world, transforming cosmology, mathematics, and the very concept of physical law.',
    tags: ['physics', 'classical mechanics', 'gravitation', 'scientific revolution'] },

  { title: "Euclid's Elements", author: 'Euclid', year: '~300 BC', language: 'Greek', category: 'formal-sciences',
    summary: 'The most reproduced mathematics text in history — a systematic axiomatic treatment of geometry and number theory.',
    note: 'The Elements defined the model of rigorous deductive proof for all subsequent mathematics and served as the primary mathematical textbook in the Western tradition for over two millennia. Its method of proceeding from definitions and postulates to theorems through strictly logical steps remains the ideal of mathematical reasoning, and its influence on the form of rational inquiry extends far beyond mathematics into philosophy, theology, and jurisprudence.',
    tags: ['geometry', 'axiomatic method', 'number theory', 'deductive proof'] },

  { title: 'The Decline and Fall of the Roman Empire', author: 'Edward Gibbon', year: '1776', language: 'English', category: 'hct',
    summary: 'Gibbon\'s monumental six-volume history tracking Rome from its height through the fall of Byzantium in 1453.',
    note: 'A masterwork of historical prose and a landmark of Enlightenment scholarship, Gibbon\'s work situates the fall of Rome within the broader history of Christianity, barbarism, and political decay. Its ironic, magisterial style and sweeping temporal scope set the standard for narrative history in the English language and established the model of secular, evidence-based historical inquiry that defines the modern discipline.',
    tags: ['Rome', 'empire', 'historiography', 'Enlightenment', 'Byzantium'] },
];

function runSeeds() {
  const existing = db.getAll();
  const existingTitles = new Set(existing.map(e => e.title));

  let seeded = 0;
  for (const entry of SEED_ENTRIES) {
    if (existingTitles.has(entry.title)) continue;

    const cat = CATEGORIES.find(c => c.id === entry.category);
    const coverSvg = generateFallbackCover(entry.title, cat);

    db.insert({
      id:       uuidv4(),
      ...entry,
      cover_svg: coverSvg,
      is_seed:  true,
      hidden:   false,
    });
    seeded++;
  }

  if (seeded > 0) console.log(`[seed] Inserted ${seeded} canonical entries.`);
  else console.log('[seed] All canonical entries already present.');
}

module.exports = { runSeeds };
