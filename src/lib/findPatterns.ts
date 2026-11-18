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

export function ibanValid(s: string): boolean {
  const t = s.replace(/\s/g, "").toUpperCase();
  if (t.length < 15 || t.length > 34) return false;
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
      re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
      accept: (m) => {
        // Greedy: may have run into the next all-caps word. Back off one
        // space-separated group at a time until the checksum holds.
        let s = m;
        for (;;) {
          if (ibanValid(s)) return s.length;
          const cut = s.lastIndexOf(" ");
          if (cut < 15) return 0;
          s = s.slice(0, cut);
        }
      },
    },
  ],

  card: [
    // Grouped in fours (16–19 digits), as printed on statements and receipts.
    {
      re: /(?<![\d-])\d{4}([ -]?)\d{4}\1\d{4}\1\d{4}(?:\1\d{1,3})?(?![\d-])/g,
      accept: (m) => (luhn(m) ? m.length : 0),
    },
    // American Express: 4-6-5.
    {
      re: /(?<![\d-])3[47]\d{2}([ -]?)\d{6}\1\d{5}(?![\d-])/g,
      accept: (m) => (luhn(m) ? m.length : 0),
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
      re: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
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
  return new RegExp(body, "giu");
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

/** The key matches are grouped under in the results list. */
export function groupKey(m: Pick<Match, "kind" | "text">): string {
  const t =
    m.kind === "text" || m.kind === "email" ? m.text.toLowerCase() : m.text;
  return m.kind + ":" + t.replace(/\s+/g, " ").trim();
}
