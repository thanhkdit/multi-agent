const { chromium } = require('playwright');
(async () => {
  const context = await chromium.launchPersistentContext('./browser-data-test', {
    headless: true,
    viewport: { width: 1280, height: 720 }
  });
  const page = context.pages()[0] || await context.newPage();
  console.log('Pages count:', context.pages().length);
  await page.goto('https://example.com');
  const buffer = await page.screenshot({ type: 'jpeg', quality: 50 });
  console.log('Buffer length:', buffer.length);
  await context.close();
})();
