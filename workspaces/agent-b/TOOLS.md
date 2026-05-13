# TOOL USAGE COMMAND
Để lấy dữ liệu, bạn BẮT BUỘC gọi lệnh terminal sau:

`node ~/openclaw-multi-agent/workspace/agent-b/scripts/universal_scraper.js "<URL_đối_thủ>" "<Limit>" "<crawl_focus_optional>" "<require_login_optional>"`

# THAM SỐ
- Tham số 1: URL đối tượng cần crawl
- Tham số 2: Limit số bài
- Tham số 3: crawl_focus, nếu có
- Tham số 4: require_login, nếu có

# VÍ DỤ
Ví dụ Agent-A truyền task:
`https://facebook.com/abc | 15 | marketing_analysis | require_login`

Bạn phải gọi:
`node ~/openclaw-multi-agent/workspace/agent-b/scripts/universal_scraper.js "https://facebook.com/abc" "15" "marketing_analysis" "require_login"`

Nếu không có yêu cầu login:
`node ~/openclaw-multi-agent/workspace/agent-b/scripts/universal_scraper.js "https://facebook.com/abc" "15" "marketing_analysis"`

Nếu không có mode:
`node ~/openclaw-multi-agent/workspace/agent-b/scripts/universal_scraper.js "https://facebook.com/abc" "15"`