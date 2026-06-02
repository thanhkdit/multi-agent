#!/usr/bin/env node

/**
 * session_generator.js
 *
 * Script để admin/user login Facebook thủ công trên server.
 * Mở Chromium headful với persistent profile (browser-data/),
 * cung cấp URL CDP remote debug để admin điều khiển từ xa.
 *
 * Cách chạy:
 *   node scripts/session_generator.js            # Login nếu session hết hạn
 *   node scripts/session_generator.js --check    # Chỉ kiểm tra trạng thái
 *   node scripts/session_generator.js --force    # Bắt buộc login lại
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  checkSessionStatus,
  startRemoteLoginSession
} = require('./session_manager');

const args = process.argv.slice(2);
const isCheckOnly = args.includes('--check');
const isForce = args.includes('--force');

async function main() {
  if (isCheckOnly) {
    const status = checkSessionStatus();
    console.log('\n📋 Trạng thái Session Facebook:');
    console.log('─'.repeat(50));
    console.log(`  Status:  ${status.status}`);
    console.log(`  Detail:  ${status.detail}`);
    if (status.cUser) console.log(`  User ID: ${status.cUser}`);
    if (status.expiresAt) console.log(`  Hết hạn: ${status.expiresAt}`);
    console.log('─'.repeat(50));
    process.exit(status.status === 'valid' ? 0 : 1);
  }

  const result = await startRemoteLoginSession({ force: isForce });

  if (result.success) {
    console.log('\n✅ Hoàn tất. Session sẵn sàng sử dụng.');
  } else {
    console.log('\n❌ Không thể tạo session. Thử lại: node scripts/session_generator.js --force');
  }

  process.exit(result.success ? 0 : 1);
}

main();