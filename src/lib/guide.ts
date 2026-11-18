// Steps and FAQs for a tool page, written once and rendered twice: as the
// visible HowToSteps / FaqList, and as schema.org HowTo / FAQPage data. Keeping
// one source means the structured data can't drift from what the page says.

export interface Step {
  name: string;
  /** May contain inline HTML (links, <em>). The schema gets the plain text. */
  text: string;
}

export interface Faq {
  q: string;
  /** May contain inline HTML. The schema gets the plain text. */
  a: string;
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export function howToSchema(name: string, steps: Step[]) {
  return {
    "@type": "HowTo",
    name,
    step: steps.map((s) => ({ "@type": "HowToStep", name: s.name, text: plain(s.text) })),
  };
}

export function faqSchema(faqs: Faq[]) {
  return {
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: plain(f.a) },
    })),
  };
}
