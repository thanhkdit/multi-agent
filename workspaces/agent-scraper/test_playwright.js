const { chromium } = require('playwright');

(async () => {
  try {
    const context1 = await chromium.launchPersistentContext('./browser-data-test2', { headless: true });
    
    // Attempt to launch another one simultaneously
    const context2 = await chromium.launchPersistentContext('./browser-data-test2', { headless: true });
    
    console.log('Success');
    await context1.close();
    await context2.close();
  } catch(e) {
    console.error('Error:', e.message);
  }
})();
