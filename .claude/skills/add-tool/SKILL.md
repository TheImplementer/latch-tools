---
name: add-tool
description: Scaffold a new tool page following the standard file-tools-webapp structure. Invoked with /add-tool <tool-slug> (e.g. /add-tool heic-to-jpg).
disable-model-invocation: true
---

The user wants to add a new tool to the file-tools-webapp. The argument is $ARGUMENTS (e.g. "heic-to-jpg", "remove-exif", "png-to-jpg").

Derive from the slug:
- The page path: `src/pages/$ARGUMENTS.astro`
- A human-readable title (e.g. "heic-to-jpg" → "HEIC to JPG Converter")
- A short meta description focused on the privacy angle (e.g. "Convert HEIC photos to JPG in your browser — no upload, no server, files stay on your device.")

Scaffold the Astro page with this structure:

1. **Frontmatter/imports:** Import any needed client-side libraries with dynamic `import()` inside event handlers — NOT at the top level. This ensures WASM and heavy libs are lazy-loaded.

2. **SEO head:** `<title>`, `<meta name="description">`, an H1, and JSON-LD structured data (SoftwareApplication schema minimum; add FAQ schema if the tool has obvious FAQ content).

3. **Drop zone:** Drag-and-drop area plus a hidden `<input type="file">` triggered on click. Show the selected filename and file size once a file is chosen.

4. **"Convert" button:** Explicit user action to start processing (consistent across all tools — do not auto-convert on drop).

5. **Progress indicator:** Show a spinner or progress message for any operation that may exceed ~300ms. Hide it when done.

6. **Result area:** One-click Download button with an auto-generated filename (input stem + new extension). A "Convert another" button that resets state without a page reload.

7. **Error handling:** Catch unsupported format, corrupt file, and out-of-memory errors. Show a plain-language message (never a raw JS error or stack trace).

8. **Supporting content:** Below the tool UI, add an HTML section with:
   - A short explanation of what the tool does and why privacy matters here
   - Step-by-step usage instructions
   - A short FAQ (3–5 questions) relevant to this tool
   - A note that files never leave the user's device

9. **Privacy statement:** Prominently state "Your files never leave your device" on the page (in the tool UI area, not just the footer).

After scaffolding, check `mvp-requirements.md` for any tool-specific notes (quality sliders, presets, background-colour pickers, etc.) and add them to the implementation.

Finally, note that the tool will need to be linked from the home page (`src/pages/index.astro`) — remind the user to add it there.
