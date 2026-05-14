#!/usr/bin/env node
const { createBrowser } = require("./browser");
const fs = require("fs");

function normalizeText(str = "") {
  return str
    .toLowerCase()
    .trim();
}

async function main() {
  const mode = process.argv[2];
  const query = process.argv[3];

  if (!mode || !query) {
    console.log(JSON.stringify({
      type: "error",
      reason: "missing_arguments"
    }));
    process.exit(1);
  }

  try {
    switch (mode) {
      case "page_lookup":
        return await handlePageLookup(query);

      case "ads_library_lookup":
        return await handleAdsLibraryLookup(query);

      default:
        return outputError("unsupported_mode");
    }
  } catch (err) {
    return outputError(err.message);
  }
}

async function handlePageLookup(query) {
  const { context, page, close } = await createBrowser();
  try {
    const searchUrl =
      `https://www.facebook.com/search/pages/?q=${encodeURIComponent(query)}`;

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    const links = await page.$$eval("a", els => {
      return els
        .map(el => ({
          text: el.innerText,
          href: el.href
        }))
        .filter(x =>
          x.href &&
          x.href.includes("facebook.com") &&
          !x.href.includes("/search/")
        )
        .slice(0, 10);
    });

    const results = links.map(link => ({
      name: link.text || "Unknown",
      facebook_url: link.href,
      verified: false,
      confidence: 80
    }));

    return output({
      type: "page_lookup",
      query,
      results
    });

  } finally {
    await close();
  }
}

async function handleAdsLibraryLookup(query) {
  const { page, close } = await createBrowser();

  try {
    await page.goto(
      "https://www.facebook.com/ads/library/",
      {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }
    );

    await page.waitForLoadState("domcontentloaded");

    await page.waitForTimeout(10000);

    await page.screenshot({
      path: "debug_ads_library_loaded.png",
      fullPage: true
    });

    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input"))
        .map(input => ({
          type: input.type,
          placeholder: input.placeholder,
          ariaLabel: input.getAttribute("aria-label")
        }));
    });

    console.log(JSON.stringify({
      debug_inputs: inputs
    }, null, 2));

    const searchInput = page.locator("input").first();

    await searchInput.waitFor({
      state: "visible",
      timeout: 30000
    });

    await searchInput.click();

    await searchInput.fill("");

    await searchInput.type(query, {
      delay: 120
    });

    await page.waitForTimeout(5000);

    await page.waitForTimeout(5000);

    await page.screenshot({
      path: "ads_library_dropdown.png",
      fullPage: true
    });

    const advertisers = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));

      return anchors
        .map(a => ({
          text: a.innerText?.trim(),
          href: a.href
        }))
        .filter(x =>
          x.text &&
          x.href &&
          x.href.includes("facebook.com")
        )
        .slice(0, 20);
    });

    const normalizedQuery = normalizeText(query);

    const results = advertisers
      .map(ad => {
        const normalizedName =
          normalizeText(ad.text);

        let confidence = 50;

        if (
          normalizedName.includes(normalizedQuery)
        ) {
          confidence = 95;
        }

        return {
          name: ad.text,
          facebook_url: ad.href,
          ads_library_url: null,
          confidence
        };
      })
      .filter(x => x.confidence >= 70)
      .sort((a, b) => b.confidence - a.confidence);

    return output({
      type: "ads_library_lookup",
      query,
      results
    });

  } finally {
    await close();
  }
}

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function outputError(reason) {
  output({
    type: "error",
    reason
  });
}

main();
