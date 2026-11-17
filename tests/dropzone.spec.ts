// Cover for src/lib/dropzone.ts, extracted out of the three controllers that
// had grown identical copies of it (redact.ts and both PDF controllers).
//
// The rest of the suite loads files with setInputFiles, which only ever
// exercises the change handler. Everything else the drop zone does — the drag
// handlers, the browse button, keyboard operability, and the flag that tells
// "start a new batch" from "add to this one" — had no cover at all, which is
// exactly the wrong thing to be true of code that has just been moved.

import { expect, test } from "@playwright/test";
import { openTool } from "./helpers";
import type { Page } from "@playwright/test";
import { makeFormPdf, makeTestPng } from "./fixtures";

/**
 * Drop a real file onto an element.
 *
 * The File has to be constructed inside the page: a DataTransfer can only hold
 * File objects from its own realm, so it can't be assembled test-side.
 */
async function dropFiles(
  page: Page,
  selector: string,
  files: { name: string; type: string; bytes: Uint8Array }[],
) {
  const handle = await page.evaluateHandle(
    (payload) => {
      const dt = new DataTransfer();
      for (const { name, type, b64 } of payload) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        dt.items.add(new File([arr], name, { type }));
      }
      return dt;
    },
    files.map((f) => ({
      name: f.name,
      type: f.type,
      b64: Buffer.from(f.bytes).toString("base64"),
    })),
  );
  await page.locator(selector).dispatchEvent("drop", { dataTransfer: handle });
}

test("a dragged-and-dropped PDF is loaded, and the label tracks the drag", async ({
  page,
}) => {
  await openTool(page, "/flatten-pdf/");
  const zone = page.locator('[data-el="dropzone"]');
  const title = page.locator('[data-el="dz-title"]');

  await expect(title).toHaveText("Drag & drop your PDF");

  // dragover has to be prevented for the element to be a drop target at all;
  // the label change is the visible proof it was.
  await zone.dispatchEvent("dragover");
  await expect(title).toHaveText("Drop to open your PDF");
  await expect(zone).toHaveClass(/is-drag/);

  // A drag that leaves must reset the zone rather than stick.
  await zone.dispatchEvent("dragleave");
  await expect(title).toHaveText("Drag & drop your PDF");
  await expect(zone).not.toHaveClass(/is-drag/);

  await dropFiles(page, '[data-el="dropzone"]', [
    {
      name: "application.pdf",
      type: "application/pdf",
      bytes: await makeFormPdf(),
    },
  ]);

  await expect(page.locator('[data-panel="options"]')).toBeVisible();
  await expect(page.locator('[data-el="file-name"]')).toHaveText(
    "application.pdf",
  );
  // And the label was restored on the way through, not left mid-drag.
  await expect(title).toHaveText("Drag & drop your PDF");
});

test("the browse button opens the picker exactly once", async ({ page }) => {
  await openTool(page, "/flatten-pdf/");

  // Counting `filechooser` events cannot see this: once a chooser is open the
  // browser won't fire a second one, so a duplicate open is invisible from
  // outside. Count the calls instead — the button sits INSIDE the drop zone, so
  // without stopPropagation the zone's own click handler runs next and asks for
  // the picker a second time.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(
      '[data-el="file-input"]',
    )!;
    (window as unknown as { __picks: number }).__picks = 0;
    // Deliberately does not call through, so no native dialog opens.
    el.click = () => {
      (window as unknown as { __picks: number }).__picks++;
    };
  });

  await page.locator('[data-el="browse-btn"]').click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __picks: number }).__picks,
    ),
  ).toBe(1);

  // The zone itself still opens it when clicked directly.
  await page.locator('[data-el="dropzone"]').click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __picks: number }).__picks,
    ),
  ).toBe(2);
});

test("the drop zone is operable from the keyboard", async ({ page }) => {
  await openTool(page, "/flatten-pdf/");
  const zone = page.locator('[data-el="dropzone"]');

  await zone.focus();
  await expect(zone).toBeFocused();

  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  expect((await chooser).isMultiple()).toBe(false);

  // Space is the other key a role="button" has to answer to.
  const second = page.waitForEvent("filechooser");
  await page.keyboard.press(" ");
  await second;
});

test("the filmstrip's + adds to the batch while the drop zone replaces it", async ({
  page,
}) => {
  const png = {
    name: "one.png",
    mimeType: "image/png",
    buffer: Buffer.from(makeTestPng()),
  };
  await openTool(page, "/redact-image/");
  // Two to begin with: the filmstrip only renders for a batch of 2 or more.
  await page
    .locator('[data-el="file-input"]')
    .setInputFiles([png, { ...png, name: "two.png" }]);
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();

  const thumbs = page.locator('[data-el="filmstrip"] [data-thumb]');
  await expect(thumbs).toHaveCount(2);

  // The + button means "add to what's on screen".
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-el="strip-add"]').click();
  await (await chooser).setFiles([{ ...png, name: "three.png" }]);
  await expect(thumbs).toHaveCount(3);

  // A drop, by contrast, starts a fresh batch — this is the distinction the
  // extracted onFreshSelection hook carries, and it has no other cover. Two
  // files again, so a strip that stayed at 3 (appended) is distinguishable
  // from one that reset to 2 (replaced).
  await dropFiles(page, '[data-el="dropzone"]', [
    { name: "replacement.png", type: "image/png", bytes: makeTestPng() },
    { name: "replacement-2.png", type: "image/png", bytes: makeTestPng() },
  ]);
  await expect(page.locator('[data-panel="editor"]')).toBeVisible();
  await expect(thumbs).toHaveCount(2);
});
