# ClickHouse SQL Analytic Agent

Agent chuyên biệt chịu trách nhiệm nhận thông tin, suy luận, tự thiết lập và thực thi các truy vấn SQL ClickHouse, trả về kết quả trực tiếp cho Orchestrator thông qua session.

## Configuration

1. Cấu hình các thông số kết nối ClickHouse trong file `.env`:
```
CLICKHOUSE_HOST=http://localhost
CLICKHOUSE_PORT=8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=default
```

## Tool Usage

```bash
node scripts/clickhouse/query.js "<sql_query>"
```

## Output Format

Kết quả trả về luôn ở định dạng JSON:
```json
{
  "meta": [
    {
      "name": "column_name",
      "type": "type_name"
    }
  ],
  "data": [
    {
      "column_name": "value"
    }
  ],
  "rows": 1
}
```
