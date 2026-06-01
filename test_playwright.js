const { chromium } = require('playwright');
(async () => {
  try {
    const isHeadless = true;
    console.log('isHeadless:', isHeadless, typeof isHeadless);
    const context = await chromium.launchPersistentContext('./browser-data-test2', {
      headless: isHeadless
    });
    console.log('Success');
    await context.close();
  } catch(e) {
    console.error('Error:', e.message);
  }
})();
