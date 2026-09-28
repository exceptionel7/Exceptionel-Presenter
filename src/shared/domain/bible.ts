/**
 * EXCEPTIONEL PRESENTER — the canonical book table (Phase 4).
 *
 * ZERO dependencies, so the parser, the repository, the importer and the operator UI all agree on
 * what a book is called.
 *
 * ON LICENSING, UP FRONT. This file contains NO SCRIPTURE. Book names, their order and the
 * abbreviations people type are facts about a canon, not a copyrightable translation. Actual verse
 * text never ships with this application: it is installed from a translation package whose licence
 * the operator supplies and which the importer refuses to accept without. See docs/BIBLE.md.
 *
 * Scope is the 66-book Protestant canon. Deuterocanonical and apocryphal books are absent — adding
 * them is a data-table change and nothing else, because every consumer reads this table rather than
 * assuming a count.
 */

export interface BibleBookMeta {
  /** 1-based canonical position. Stable: it is the sort key and the storage key. */
  number: number;
  /** The name shown to the operator and used in a normalised reference. */
  name: string;
  /** The short form used where space is tight. */
  abbreviation: string;
  /**
   * The form used when citing ONE chapter of a plural-named book: "Psalm 23", never "Psalms 23".
   *
   * A small thing that matters, because it is projected in front of a congregation and read aloud.
   */
  singularName?: string;
  /**
   * True for the five books with a single chapter: Obadiah, Philemon, 2 John, 3 John, Jude.
   *
   * Lets the parser read "Jude 3" as verse 3 rather than chapter 3, which is what anyone writing it
   * means. This is canonical structure, not translation-specific data, so it belongs here.
   */
  singleChapter?: boolean;
  /**
   * Everything a person might reasonably type, lower-cased and without punctuation.
   *
   * Includes the Roman-numeral spellings ("i corinthians"), the no-space forms people type in a
   * hurry ("1cor", "songofsolomon"), and genuine alternative names ("canticles", "apocalypse").
   */
  aliases: readonly string[];
  section: 'old' | 'new';
}

/**
 * The canon, in order.
 *
 * Aliases are deliberately generous but never ambiguous: no string appears under two books. A test
 * asserts that, because a collision would silently resolve "Jud" to whichever book happened to be
 * listed first — and Judges, Jude and Judith are three different things.
 */
export const BIBLE_BOOKS: readonly BibleBookMeta[] = Object.freeze([
  // ── Old Testament ─────────────────────────────────────────────────────────────
  { number: 1, name: 'Genesis', abbreviation: 'Gen', aliases: ['gen', 'ge', 'gn'], section: 'old' },
  { number: 2, name: 'Exodus', abbreviation: 'Exod', aliases: ['exo', 'exod', 'ex'], section: 'old' },
  { number: 3, name: 'Leviticus', abbreviation: 'Lev', aliases: ['lev', 'le', 'lv'], section: 'old' },
  { number: 4, name: 'Numbers', abbreviation: 'Num', aliases: ['num', 'nu', 'nm', 'nb'], section: 'old' },
  { number: 5, name: 'Deuteronomy', abbreviation: 'Deut', aliases: ['deut', 'deu', 'dt'], section: 'old' },
  { number: 6, name: 'Joshua', abbreviation: 'Josh', aliases: ['josh', 'jos', 'jsh'], section: 'old' },
  { number: 7, name: 'Judges', abbreviation: 'Judg', aliases: ['judg', 'jdg', 'jdgs'], section: 'old' },
  { number: 8, name: 'Ruth', abbreviation: 'Ruth', aliases: ['ruth', 'rth', 'ru'], section: 'old' },
  {
    number: 9,
    name: '1 Samuel',
    abbreviation: '1 Sam',
    aliases: ['1sam', '1sa', '1s', 'isam', 'isamuel', '1samuel', 'firstsamuel'],
    section: 'old',
  },
  {
    number: 10,
    name: '2 Samuel',
    abbreviation: '2 Sam',
    aliases: ['2sam', '2sa', '2s', 'iisam', 'iisamuel', '2samuel', 'secondsamuel'],
    section: 'old',
  },
  {
    number: 11,
    name: '1 Kings',
    abbreviation: '1 Kgs',
    aliases: ['1kgs', '1ki', '1kin', '1k', 'ikings', '1kings', 'firstkings'],
    section: 'old',
  },
  {
    number: 12,
    name: '2 Kings',
    abbreviation: '2 Kgs',
    aliases: ['2kgs', '2ki', '2kin', '2k', 'iikings', '2kings', 'secondkings'],
    section: 'old',
  },
  {
    number: 13,
    name: '1 Chronicles',
    abbreviation: '1 Chr',
    aliases: ['1chr', '1ch', '1chron', 'ichronicles', '1chronicles', 'firstchronicles'],
    section: 'old',
  },
  {
    number: 14,
    name: '2 Chronicles',
    abbreviation: '2 Chr',
    aliases: ['2chr', '2ch', '2chron', 'iichronicles', '2chronicles', 'secondchronicles'],
    section: 'old',
  },
  { number: 15, name: 'Ezra', abbreviation: 'Ezra', aliases: ['ezra', 'ezr', 'ez'], section: 'old' },
  { number: 16, name: 'Nehemiah', abbreviation: 'Neh', aliases: ['neh', 'ne'], section: 'old' },
  { number: 17, name: 'Esther', abbreviation: 'Esth', aliases: ['esth', 'est', 'es'], section: 'old' },
  { number: 18, name: 'Job', abbreviation: 'Job', aliases: ['job', 'jb'], section: 'old' },
  {
    number: 19,
    name: 'Psalms',
    abbreviation: 'Ps',
    singularName: 'Psalm',
    aliases: ['ps', 'psa', 'psalm', 'psalms', 'pslm', 'psm'],
    section: 'old',
  },
  { number: 20, name: 'Proverbs', abbreviation: 'Prov', aliases: ['prov', 'pro', 'prv', 'pr'], section: 'old' },
  { number: 21, name: 'Ecclesiastes', abbreviation: 'Eccl', aliases: ['eccl', 'ecc', 'ec', 'qoheleth'], section: 'old' },
  {
    number: 22,
    name: 'Song of Solomon',
    abbreviation: 'Song',
    aliases: ['song', 'songofsolomon', 'songofsongs', 'sos', 'canticles', 'cant'],
    section: 'old',
  },
  { number: 23, name: 'Isaiah', abbreviation: 'Isa', aliases: ['isa', 'is'], section: 'old' },
  { number: 24, name: 'Jeremiah', abbreviation: 'Jer', aliases: ['jer', 'je', 'jr'], section: 'old' },
  { number: 25, name: 'Lamentations', abbreviation: 'Lam', aliases: ['lam', 'la'], section: 'old' },
  { number: 26, name: 'Ezekiel', abbreviation: 'Ezek', aliases: ['ezek', 'eze', 'ezk'], section: 'old' },
  { number: 27, name: 'Daniel', abbreviation: 'Dan', aliases: ['dan', 'da', 'dn'], section: 'old' },
  { number: 28, name: 'Hosea', abbreviation: 'Hos', aliases: ['hos', 'ho'], section: 'old' },
  { number: 29, name: 'Joel', abbreviation: 'Joel', aliases: ['joel', 'joe', 'jl'], section: 'old' },
  { number: 30, name: 'Amos', abbreviation: 'Amos', aliases: ['amos', 'amo', 'am'], section: 'old' },
  { number: 31, name: 'Obadiah', abbreviation: 'Obad', singleChapter: true, aliases: ['obad', 'oba', 'ob'], section: 'old' },
  { number: 32, name: 'Jonah', abbreviation: 'Jonah', aliases: ['jonah', 'jon', 'jnh'], section: 'old' },
  { number: 33, name: 'Micah', abbreviation: 'Mic', aliases: ['mic', 'mc'], section: 'old' },
  { number: 34, name: 'Nahum', abbreviation: 'Nah', aliases: ['nah', 'na'], section: 'old' },
  // 'hb' is deliberately absent from both this and Hebrews: it is genuinely ambiguous. The first
  // draft of this table gave it to both, and because the lookup map is insertion-ordered Hebrews
  // silently won — so "Hb 2:4" would have put Hebrews on the projector without a word of warning.
  { number: 35, name: 'Habakkuk', abbreviation: 'Hab', aliases: ['hab'], section: 'old' },
  { number: 36, name: 'Zephaniah', abbreviation: 'Zeph', aliases: ['zeph', 'zep', 'zp'], section: 'old' },
  { number: 37, name: 'Haggai', abbreviation: 'Hag', aliases: ['hag', 'hg'], section: 'old' },
  { number: 38, name: 'Zechariah', abbreviation: 'Zech', aliases: ['zech', 'zec', 'zc'], section: 'old' },
  { number: 39, name: 'Malachi', abbreviation: 'Mal', aliases: ['mal', 'ml'], section: 'old' },

  // ── New Testament ─────────────────────────────────────────────────────────────
  { number: 40, name: 'Matthew', abbreviation: 'Matt', aliases: ['matt', 'mat', 'mt'], section: 'new' },
  { number: 41, name: 'Mark', abbreviation: 'Mark', aliases: ['mark', 'mrk', 'mk', 'mr'], section: 'new' },
  { number: 42, name: 'Luke', abbreviation: 'Luke', aliases: ['luke', 'luk', 'lk'], section: 'new' },
  { number: 43, name: 'John', abbreviation: 'John', aliases: ['john', 'joh', 'jhn', 'jn'], section: 'new' },
  { number: 44, name: 'Acts', abbreviation: 'Acts', aliases: ['acts', 'act', 'ac'], section: 'new' },
  { number: 45, name: 'Romans', abbreviation: 'Rom', aliases: ['rom', 'ro', 'rm'], section: 'new' },
  {
    number: 46,
    name: '1 Corinthians',
    abbreviation: '1 Cor',
    aliases: ['1cor', '1co', '1c', 'icorinthians', '1corinthians', 'firstcorinthians'],
    section: 'new',
  },
  {
    number: 47,
    name: '2 Corinthians',
    abbreviation: '2 Cor',
    aliases: ['2cor', '2co', '2c', 'iicorinthians', '2corinthians', 'secondcorinthians'],
    section: 'new',
  },
  { number: 48, name: 'Galatians', abbreviation: 'Gal', aliases: ['gal', 'ga'], section: 'new' },
  { number: 49, name: 'Ephesians', abbreviation: 'Eph', aliases: ['eph', 'ephes'], section: 'new' },
  // 'ph' is deliberately absent from both: it would be ambiguous between these two.
  { number: 50, name: 'Philippians', abbreviation: 'Phil', aliases: ['phil', 'php', 'pp'], section: 'new' },
  { number: 51, name: 'Colossians', abbreviation: 'Col', aliases: ['col', 'co'], section: 'new' },
  {
    number: 52,
    name: '1 Thessalonians',
    abbreviation: '1 Thess',
    aliases: ['1thess', '1th', '1thes', 'ithessalonians', '1thessalonians', 'firstthessalonians'],
    section: 'new',
  },
  {
    number: 53,
    name: '2 Thessalonians',
    abbreviation: '2 Thess',
    aliases: ['2thess', '2th', '2thes', 'iithessalonians', '2thessalonians', 'secondthessalonians'],
    section: 'new',
  },
  {
    number: 54,
    name: '1 Timothy',
    abbreviation: '1 Tim',
    aliases: ['1tim', '1ti', '1tm', 'itimothy', '1timothy', 'firsttimothy'],
    section: 'new',
  },
  {
    number: 55,
    name: '2 Timothy',
    abbreviation: '2 Tim',
    aliases: ['2tim', '2ti', '2tm', 'iitimothy', '2timothy', 'secondtimothy'],
    section: 'new',
  },
  { number: 56, name: 'Titus', abbreviation: 'Titus', aliases: ['titus', 'tit', 'ti'], section: 'new' },
  { number: 57, name: 'Philemon', abbreviation: 'Phlm', singleChapter: true, aliases: ['phlm', 'philem', 'pm'], section: 'new' },
  { number: 58, name: 'Hebrews', abbreviation: 'Heb', aliases: ['heb'], section: 'new' },
  { number: 59, name: 'James', abbreviation: 'Jas', aliases: ['jas', 'james', 'jm'], section: 'new' },
  {
    number: 60,
    name: '1 Peter',
    abbreviation: '1 Pet',
    aliases: ['1pet', '1pe', '1pt', '1p', 'ipeter', '1peter', 'firstpeter'],
    section: 'new',
  },
  {
    number: 61,
    name: '2 Peter',
    abbreviation: '2 Pet',
    aliases: ['2pet', '2pe', '2pt', '2p', 'iipeter', '2peter', 'secondpeter'],
    section: 'new',
  },
  {
    number: 62,
    name: '1 John',
    abbreviation: '1 John',
    aliases: ['1john', '1jn', '1jo', '1joh', '1j', 'ijohn', 'firstjohn'],
    section: 'new',
  },
  {
    number: 63,
    name: '2 John',
    abbreviation: '2 John',
    singleChapter: true,
    aliases: ['2john', '2jn', '2jo', '2joh', '2j', 'iijohn', 'secondjohn'],
    section: 'new',
  },
  {
    number: 64,
    name: '3 John',
    abbreviation: '3 John',
    singleChapter: true,
    aliases: ['3john', '3jn', '3jo', '3joh', '3j', 'iiijohn', 'thirdjohn'],
    section: 'new',
  },
  // 'jud' is deliberately absent: Judges and Jude would collide.
  { number: 65, name: 'Jude', abbreviation: 'Jude', singleChapter: true, aliases: ['jude', 'jde'], section: 'new' },
  {
    number: 66,
    name: 'Revelation',
    abbreviation: 'Rev',
    aliases: ['rev', 're', 'revelations', 'apocalypse', 'apoc'],
    section: 'new',
  },
]);

export const BOOK_COUNT = BIBLE_BOOKS.length;

/**
 * Normalises a book name for matching: lower-case, no punctuation, no whitespace, and Roman numeral
 * prefixes folded onto digits.
 *
 * "1 John", "1John", "I John", "i john", "First John" and "1st John" must all reach the same book,
 * because operators type all of them under pressure.
 */
export function normaliseBookKey(raw: string): string {
  let value = raw
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks, so "Génesis" pasted from elsewhere still matches.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,'’]/g, '')
    .trim();

  // Ordinals and words to digits, before whitespace is removed so word boundaries still exist.
  value = value
    .replace(/^(1st|first)\s+/, '1 ')
    .replace(/^(2nd|second)\s+/, '2 ')
    .replace(/^(3rd|third)\s+/, '3 ')
    // Roman numerals only in the leading position: "iii john" is a book number, but the "ii" inside
    // a word must not be touched.
    .replace(/^iii\s+/, '3 ')
    .replace(/^ii\s+/, '2 ')
    .replace(/^i\s+/, '1 ');

  return value.replace(/[\s-]+/g, '');
}

/** Every accepted spelling, mapped to its book. Built once. */
const BY_KEY: ReadonlyMap<string, BibleBookMeta> = (() => {
  const map = new Map<string, BibleBookMeta>();
  for (const book of BIBLE_BOOKS) {
    for (const key of [normaliseBookKey(book.name), normaliseBookKey(book.abbreviation), ...book.aliases]) {
      map.set(key, book);
    }
  }
  return map;
})();

export const bookByNumber = (number: number): BibleBookMeta | null =>
  BIBLE_BOOKS.find((book) => book.number === number) ?? null;

/** An exact match on a name, abbreviation or alias. */
export const bookByExactName = (raw: string): BibleBookMeta | null => BY_KEY.get(normaliseBookKey(raw)) ?? null;

export type BookMatch =
  | { kind: 'exact'; book: BibleBookMeta }
  /** A unique prefix: "Ephes" or "Revel". */
  | { kind: 'prefix'; book: BibleBookMeta }
  /** Several books start this way. Refused rather than guessed. */
  | { kind: 'ambiguous'; candidates: readonly BibleBookMeta[] }
  | { kind: 'unknown' };

/**
 * Resolves whatever the operator typed to a book.
 *
 * Exact match first, then a unique prefix. AMBIGUITY IS REFUSED, never resolved by list order: "Jud"
 * could be Judges or Jude, and silently choosing one would put the wrong passage on the projector —
 * a failure nobody would catch until it was read aloud.
 */
export function matchBook(raw: string): BookMatch {
  const key = normaliseBookKey(raw);
  if (key === '') return { kind: 'unknown' };

  const exact = BY_KEY.get(key);
  if (exact) return { kind: 'exact', book: exact };

  const candidates = BIBLE_BOOKS.filter((book) =>
    [normaliseBookKey(book.name), normaliseBookKey(book.abbreviation), ...book.aliases].some((alias) =>
      alias.startsWith(key),
    ),
  );

  if (candidates.length === 1) return { kind: 'prefix', book: candidates[0]! };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'unknown' };
}
