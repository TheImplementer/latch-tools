# Real exports

PDFs made by real word processors, which the suite can't regenerate: every
other find-and-redact fixture is built in code (`tests/fixtures.ts`), and
those only ever exercise pdf-lib's and Chromium's way of writing text.

All start from one source document, made by `make-statement-rtf.py`: a fake
bank statement with every target in red and the labels next to them in blue,
so the tests can count what a box missed and what it ate. It covers the layout
Word users actually produce: tab stops, justified text that wraps a name,
bold inside a name, an underlined link, a letter-spaced heading, table cells
that wrap a card number, shaded and navy rows, 4 pt small print.

| File | Made with |
| --- | --- |
| `pages-statement.pdf` | Pages 14 on macOS 26.6: open the RTF, File > Export To > PDF (via AppleScript `export … as PDF`). Pages drops the RTF's header, small caps and two-column section. |
| `word-web-statement.pdf` | Word for the web, November 2026: Pages' `.docx` export of the same RTF, uploaded, then File > Export > Download as PDF. |

Check a new file's metadata before committing it: this repo is public.
