// -----------------------------------------------------------------------
// What /redact-pdf/'s "Find and black out" looks for, as pure string work.
//
// No DOM and no pdf.js here, so the tests can run every pattern in Node
// against strings, and the positioning layer (./pdfFind) only has to turn a
// character range into boxes.
//
// Precision matters more than it looks. Each hit becomes a black bar, and a
// document with forty wrong bars is one nobody reviews properly, so a false
// positive costs some of the attention the review needs. Where a cheap check
// exists it is applied: Luhn for card numbers, mod-97 for IBANs, and the SSA
// and HMRC rules for SSNs and National Insurance numbers. UK sort codes and
// 8-digit account numbers have no checksum and collide with dates
// ("01-10-24") and reference numbers, so they only count when the text says
// what they are ("Sort code", "Account number") or they appear as a pair.
//
// Nothing here can promise to find everything, and the UI says so.
// -----------------------------------------------------------------------

export type FindKind =
  | "text"
  | "email"
  | "phone"
  | "bank"
  | "iban"
  | "card"
  | "nino"
  | "ssn";

export type PatternKind = Exclude<FindKind, "text">;

/** The auto-find options, in the order the widget lists them. */
export const PATTERN_KINDS: {
  kind: PatternKind;
  label: string;
  noun: [string, string];
}[] = [
  {
    kind: "email",
    label: "Email addresses",
    noun: ["email address", "email addresses"],
  },
  {
    kind: "phone",
    label: "Phone numbers",
    noun: ["phone number", "phone numbers"],
  },
  {
    kind: "bank",
    label: "Sort codes & account numbers",
    noun: ["bank detail", "bank details"],
  },
  { kind: "iban", label: "IBANs", noun: ["IBAN", "IBANs"] },
  {
    kind: "card",
    label: "Card numbers",
    noun: ["card number", "card numbers"],
  },
  {
    kind: "nino",
    label: "National Insurance numbers",
    noun: ["NI number", "NI numbers"],
  },
  {
    kind: "ssn",
    label: "US Social Security numbers",
    noun: ["Social Security number", "Social Security numbers"],
  },
];

export interface Match {
  kind: FindKind;
  /** Character range in the searched string, end exclusive. */
  start: number;
  end: number;
  /** The matched text as it appears in the document. */
  text: string;
}

// ---- Validators ----

const digits = (s: string) => s.replace(/\D/g, "");

export function luhn(s: string): boolean {
  const d = digits(s);
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return d.length > 0 && sum % 10 === 0;
}

// Every IBAN country's fixed length, from the SWIFT IBAN registry. Checking it
// matters as much as the checksum: mod-97 alone passes one random string in
// 97, so a greedy match that ran on into the next word ("… 67 NI AB 12") could
// still validate. A country missing here falls back to the checksum alone.
const IBAN_LENGTH: Record<string, number> = Object.fromEntries(
  (
    "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 " +
    "CZ24 DE22 DJ27 DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 " +
    "GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 " +
    "LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 " +
    "NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 " +
    "SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30"
  )
    .split(" ")
    .map((e) => [e.slice(0, 2), Number(e.slice(2))]),
);

export function ibanValid(s: string): boolean {
  const t = s.replace(/\s/g, "").toUpperCase();
  if (t.length < 15 || t.length > 34) return false;
  const want = IBAN_LENGTH[t.slice(0, 2)];
  if (want && t.length !== want) return false;
  const r = t.slice(4) + t.slice(0, 4);
  let m = 0;
  for (const ch of r) {
    const c = ch.charCodeAt(0);
    const v = c >= 65 ? String(c - 55) : ch;
    for (const dch of v) m = (m * 10 + (dch.charCodeAt(0) - 48)) % 97;
  }
  return m === 1;
}

// ---- Patterns ----
//
// Each rule is a global regex plus an optional `accept`, which sees the match
// and the whole string and returns the accepted length (0 = reject). Returning
// a length lets a rule trim a greedy match, which the IBAN rule needs: it can't
// tell where an IBAN ends and an all-caps word like "BIC" begins until the
// checksum says so.

interface Rule {
  re: RegExp;
  accept?: (m: string, text: string, at: number) => number;
}

/**
 * A grouped card number spaces its groups one way throughout ("4111 1111 …",
 * "4111-1111-…" or not at all), except where the line wrapped. `cuts` are the
 * digit counts its groups end at. Two numbers that happen to sit side by side
 * ("87654321 12345678") space themselves inconsistently and fail this.
 */
function sameSeparators(m: string, cuts: number[]): boolean {
  const seps = new Set<string>();
  let n = 0;
  for (let i = 0; i < m.length; i++) {
    if (!/\d/.test(m[i])) continue;
    n++;
    if (!cuts.includes(n)) continue;
    const next = /\d/.test(m[i + 1] ?? "") ? "" : m[i + 1];
    if (next !== undefined && next !== "\n") seps.add(next);
  }
  return seps.size <= 1;
}

const before = (text: string, at: number, n: number) =>
  text.slice(Math.max(0, at - n), at);

const SORT_LABEL = /(?:sort\s*code|\bsort\b|\bs\/c\b)[^\n]{0,12}$/i;
const ACCOUNT_LABEL =
  /(?:\baccount|\bacc(?:t)?\.?|\ba\/c)(?:\s*(?:number|no\.?|#))?[\s:.#-]{0,4}$/i;
const SSN_LABEL =
  /(?:\bssn\b|social\s+security(?:\s+(?:number|no\.?))?|\bss#)[\s:.#-]{0,4}$/i;

const RULES: Record<PatternKind, Rule[]> = {
  email: [{ re: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi }],

  phone: [
    // UK: +44 or a leading 0, then 9 or 10 more digits in any common grouping.
    {
      re: /(?<![\w+])(?:\+44\s?(?:\(0\)\s?)?|0)[1-9]\d{1,4}(?:[\s-]?\d{2,4}){1,3}(?!\d)/g,
      accept: (m) => {
        const d = digits(m);
        const national =
          d.startsWith("44") && m.trim().startsWith("+")
            ? d.slice(2).replace(/^0/, "")
            : d.slice(1);
        return national.length >= 9 && national.length <= 10 ? m.length : 0;
      },
    },
    // North America: (212) 555-0147, 212-555-0147, 212.555.0147, +1 …
    {
      re: /(?<![\w+])(?:\+1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g,
      accept: (m) => {
        const d = digits(m).replace(/^1(?=\d{10}$)/, "");
        return /^[2-9]\d{2}[2-9]/.test(d) ? m.length : 0;
      },
    },
    // Anything else written in international form.
    {
      re: /\+\d{1,3}(?:[\s.-]?\(?\d{1,5}\)?){2,6}(?!\d)/g,
      accept: (m) => {
        const n = digits(m).length;
        return n >= 8 && n <= 15 ? m.length : 0;
      },
    },
  ],

  bank: [
    // A sort code needs its label, or an 8-digit account number right after it.
    {
      re: /(?<![\d-])\d{2}[-\s]\d{2}[-\s]\d{2}(?![\d-])/g,
      accept: (m, text, at) => {
        if (SORT_LABEL.test(before(text, at, 40))) return m.length;
        if (
          /^\d{2}-\d{2}-\d{2}$/.test(m) &&
          /^\s+\d{8}(?!\d)/.test(text.slice(at + m.length))
        )
          return m.length;
        return 0;
      },
    },
    // An account number needs its label, or a sort code right before it.
    {
      re: /(?<![\d.,-])\d{8}(?![\d.,-])/g,
      accept: (m, text, at) => {
        const b = before(text, at, 40);
        if (ACCOUNT_LABEL.test(b)) return m.length;
        if (/(?<![\d-])\d{2}-\d{2}-\d{2}\s+$/.test(b)) return m.length;
        return 0;
      },
    },
  ],

  iban: [
    {
      re: /\b[A-Z]{2}\d{2}(?:[ \n]?[A-Z0-9]){11,30}\b/g,
      accept: (m) => {
        // Greedy: may have run into the next all-caps word. Back off one
        // space-separated group at a time until the checksum holds.
        let s = m;
        for (;;) {
          if (ibanValid(s)) return s.length;
          const cut = Math.max(s.lastIndexOf(" "), s.lastIndexOf("\n"));
          if (cut < 15) return 0;
          s = s.slice(0, cut);
        }
      },
    },
  ],

  card: [
    // Grouped in fours (16–19 digits), as printed on statements and receipts.
    {
      re: /(?<![\d-])\d{4}[ \n-]?\d{4}[ \n-]?\d{4}[ \n-]?\d{4}(?:[ \n-]?\d{1,3})?(?![\d-])/g,
      accept: (m) => (luhn(m) && sameSeparators(m, [4, 8, 12, 16]) ? m.length : 0),
    },
    // American Express: 4-6-5.
    {
      re: /(?<![\d-])3[47]\d{2}[ \n-]?\d{6}[ \n-]?\d{5}(?![\d-])/g,
      accept: (m) => (luhn(m) && sameSeparators(m, [4, 10]) ? m.length : 0),
    },
    // Ungrouped, 13–19 digits.
    {
      re: /(?<![\d.,-])\d{13,19}(?![\d.,-])/g,
      accept: (m) => (luhn(m) ? m.length : 0),
    },
  ],

  // HMRC: no D, F, I, Q, U, V in either letter; no O second; some prefixes
  // never issued; suffix A–D. Written in capitals, often spaced in pairs.
  nino: [
    {
      re: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][ \n]?\d{2}[ \n]?\d{2}[ \n]?\d{2}[ \n]?[A-D]\b/g,
    },
  ],

  // SSA: area never 000, 666 or 9xx; group never 00; serial never 0000.
  // Hyphenated anywhere; spaced or run together only when labelled.
  ssn: [
    {
      re: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
    },
    {
      re: /(?<![\d-])(?!000|666|9\d\d)\d{3} ?(?!00)\d{2} ?(?!0000)\d{4}(?![\d-])/g,
      accept: (m, text, at) =>
        SSN_LABEL.test(before(text, at, 30)) ? m.length : 0,
    },
  ],
};

// ---- Free-text search ----

/**
 * A regex for what the user typed.
 *
 * Case-insensitive; any run of spaces matches any run of whitespace, so a
 * phrase still matches across a line break; straight and curly quotes and the
 * various dashes are interchangeable. A query made only of digits and
 * separators also matches the same digits grouped differently ("41234567"
 * finds "4123 4567"), because how a document spaces a number is not something
 * the person searching can know.
 *
 * Letter-spaced text ("A C C O U N T  H O L D E R") also matches: PDF writers
 * set it as one character per draw, and pdf.js reads each gap as a space, the
 * word gap included. Ordinary text never has whitespace between every
 * letter, so this form finds nothing else.
 */
export function queryRegex(query: string): RegExp | null {
  const q = query.trim();
  if (q.length < 2) return null;
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const one = (c: string) => {
    if (/['‘’`]/.test(c)) return "['‘’`]";
    if (/["“”]/.test(c)) return '["“”]';
    if (/[-‐‑‒–—]/.test(c)) return "[-‐‑‒–—]";
    return esc(c);
  };
  if (/^[\d\s().+-]+$/.test(q) && digits(q).length >= 4) {
    const d = digits(q).split("");
    return new RegExp(`(?<!\\d)${d.join("[\\s.-]?")}(?!\\d)`, "g");
  }
  const body = q
    .split(/\s+/)
    .map((w) => Array.from(w).map(one).join(""))
    .join("\\s+");
  const chars = Array.from(q.replace(/\s+/g, ""));
  if (chars.length < 3) return new RegExp(body, "giu");
  const spaced = chars.map(one).join("\\s{1,3}");
  return new RegExp(`${body}|${spaced}`, "giu");
}

// ---- Entry point ----

/**
 * Every match of `query` and of the chosen patterns in `text`.
 *
 * A match that sits entirely inside another is dropped, so each stretch of
 * text is listed once (the tail of a card number that also reads as a phone
 * number). Matches that only partly overlap are both kept: each becomes a box,
 * and dropping either would leave part of the other's text uncovered.
 */
export function findMatches(
  text: string,
  query: string,
  kinds: Iterable<PatternKind>,
): Match[] {
  const all: Match[] = [];
  const re = queryRegex(query);
  if (re) {
    for (const m of text.matchAll(re)) {
      if (m[0].length)
        all.push({
          kind: "text",
          start: m.index!,
          end: m.index! + m[0].length,
          text: m[0],
        });
    }
  }
  for (const kind of kinds) {
    for (const rule of RULES[kind] ?? []) {
      for (const m of text.matchAll(rule.re)) {
        const at = m.index!;
        const len = rule.accept ? rule.accept(m[0], text, at) : m[0].length;
        if (len > 0)
          all.push({
            kind,
            start: at,
            end: at + len,
            text: m[0].slice(0, len),
          });
      }
    }
  }

  // Longest first, so a container is kept before anything inside it. At equal
  // length, what the user typed wins over a pattern.
  all.sort(
    (a, b) =>
      b.end - b.start - (a.end - a.start) ||
      Number(b.kind === "text") - Number(a.kind === "text") ||
      a.start - b.start,
  );
  const kept: Match[] = [];
  for (const m of all) {
    if (!kept.some((k) => k.start <= m.start && k.end >= m.end)) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * The key matches are grouped under in the results list. A search's hits group
 * by their letters alone, so "Jane Example", a letter-spaced "J A N E  E X A M
 * P L E" and "4123 4567" for "41234567" share one row.
 */
export function groupKey(m: Pick<Match, "kind" | "text">): string {
  if (m.kind === "text") return "text:" + m.text.toLowerCase().replace(/\s+/g, "");
  const t = m.kind === "email" ? m.text.toLowerCase() : m.text;
  return m.kind + ":" + t.replace(/\s+/g, " ").trim();
}
