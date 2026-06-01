const { chromium } = require('playwright');
const { startVncServer } = require('./workspaces/agent-scraper/scripts/vnc_server');
const { execSync, spawn } = require('child_process');

async function main() {
  const isHeadless = true; // test headless
  const browser = await chromium.launch({ headless: isHeadless });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  const server = startVncServer(page, 3000);
  console.log('Server started on port 3000');
}
main();
