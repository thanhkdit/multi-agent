/**
 * ClickHouse SQL Query Execution Script
 * 
 * Nhận vào params: câu lệnh SQL ClickHouse cần thực thi.
 * Kết nối tới ClickHouse database thông qua giao thức HTTP và trả về kết quả dưới định dạng JSON.
 *
 * Usage: node query.js "<sql_query>"
 * Example: node query.js "SELECT 1"
 */

const path = require('path');
const fs = require('fs');

// Load environment variables from local .env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

async function executeQuery(sqlQuery) {
  let host = process.env.CLICKHOUSE_HOST || 'http://localhost';
  if (!host.startsWith('http://') && !host.startsWith('https://')) {
    host = 'http://' + host;
  }
  const port = process.env.CLICKHOUSE_PORT || '8123';
  
  // Construct ClickHouse HTTP endpoint
  const url = new URL(`${host}:${port}/`);
  url.searchParams.append('default_format', 'JSON');
  if (process.env.CLICKHOUSE_DATABASE) {
    url.searchParams.append('database', process.env.CLICKHOUSE_DATABASE);
  }

  const headers = {
    'Content-Type': 'text/plain',
  };

  if (process.env.CLICKHOUSE_USER) {
    headers['X-ClickHouse-User'] = process.env.CLICKHOUSE_USER;
  }
  if (process.env.CLICKHOUSE_PASSWORD) {
    headers['X-ClickHouse-Key'] = process.env.CLICKHOUSE_PASSWORD;
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: headers,
    body: sqlQuery,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`ClickHouse HTTP Error (${response.status}): ${responseText.trim()}`);
  }

  // Parse JSON response from ClickHouse
  try {
    return JSON.parse(responseText);
  } catch (err) {
    // If it's a DDL or INSERT statement that succeeded but returns non-JSON/empty text
    return {
      status: 'success',
      raw_output: responseText
    };
  }
}

// --- Main ---
(async () => {
  const sqlQuery = process.argv[2];

  if (!sqlQuery) {
    console.error("Usage: node query.js \"<sql_query>\"");
    process.exit(1);
  }

  try {
    const result = await executeQuery(sqlQuery);
    
    // Print result JSON to stdout for the worker runner to capture
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    // Print error JSON
    console.error(JSON.stringify({
      status: "error",
      script_used: "query.js",
      error_details: err.message
    }, null, 2));
    process.exit(1);
  }
})();
