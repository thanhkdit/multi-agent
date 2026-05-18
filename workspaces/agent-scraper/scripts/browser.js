const path = require("path");
const { chromium } = require("playwright");

const USER_DATA_DIR = path.join(__dirname, "..", "browser-data");

async function createBrowser() {
  const context = await chromium.launchPersistentContext(
    USER_DATA_DIR,
    {
      headless: false,

      viewport: {
        width: 1440,
        height: 900
      },

      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",

      locale: "vi-VN",

      timezoneId: "Asia/Ho_Chi_Minh",

      permissions: [],

      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    }
  );

  const page = await context.newPage();

  page.setDefaultTimeout(60000);

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false
    });
  });

  return {
    context,
    page,

    close: async () => {
      await context.close();
    }
  };
}

module.exports = {
  createBrowser
};
