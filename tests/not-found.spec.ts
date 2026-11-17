// A missing path must be a real 404, never a 200 copy of the home page.
//
// Without dist/404.html, Cloudflare Pages answers any unknown path with the
// home page and a 200. Under /_astro/ that response also picked up
// public/_headers' one-year immutable header, so a stylesheet requested while
// a deploy was still switching over got cached at the edge as HTML and every
// page rendered unstyled (2026-11-17). With the 404 page, Pages returns 404
// and `no-store` instead. The preview server only shows the status half of
// that; the header half is Cloudflare's, checked by hand on a preview deploy.

import { expect, test } from "@playwright/test";

test("an unknown page is a 404 with a way back, not the home page", async ({
  page,
}) => {
  const res = await page.goto("/no-such-tool/");
  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Page not found");
  await expect(page).toHaveTitle(/Page not found/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await page.getByRole("link", { name: "See all tools" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("a missing build asset is a 404, never HTML with a 200", async ({
  request,
}) => {
  const res = await request.get("/_astro/does-not-exist.css");
  expect(res.status()).toBe(404);
});
