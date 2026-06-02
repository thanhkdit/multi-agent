# Facebook Scraper Setup

## Installation Complete

Dependencies installed:
- playwright
- puppeteer  
- dotenv

Playwright Chromium browser installed successfully.

## Configuration

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Edit `.env` and add your API keys:
```
# 9router API cho Vision
NINEROUTER_API_KEY=9router_api_key
NINEROUTER_URL=http://localhost:20128/v1
MODEL_VISION=model_name
MODEL=model_name
MAX_TOKEN=12000

# TikTok RapidAPI Keys (comma separated)
TIKTOK_RAPIDAPI_KEYS=key1,key2,key3
```

## Session Management (Quan trọng!)

Session Facebook được quản lý tập trung bởi `scripts/session_manager.js` và lưu tại `.openclaw/fb_session.json`.

### Kiểm tra trạng thái session

```bash
node scripts/session_generator.js --check
# hoặc
npm run session:check
```

### Login Facebook lần đầu (hoặc khi session hết hạn)

**Trên Ubuntu server (headless):**

1. Không cần cài đặt VNC. Chỉ cần đảm bảo server có `xvfb`:
```bash
sudo apt-get install -y xvfb
```

2. Chạy session generator (hoặc scraper tự động gọi):
```bash
node scripts/session_generator.js
# hoặc
npm run session:login
```

3. Script sẽ tự mở browser headful trong Xvfb và cấp quyền truy cập từ xa qua Chrome DevTools Protocol (CDP).

4. Terminal sẽ in ra một đường link dạng `http://<server_ip>:9222`.

5. Copy link này, mở bằng trình duyệt (ưu tiên Chrome/Edge) trên máy tính của bạn:
   - Click vào liên kết trang Facebook.
   - Một màn hình giống Developer Tools sẽ hiện ra cho phép bạn tương tác.
   - Đăng nhập Facebook và giải CAPTCHA (nếu có).

6. Script sẽ tự phát hiện khi login thành công và tiếp tục công việc.

### Renew session khi hết hạn

```bash
node scripts/session_generator.js --force
# hoặc
npm run session:renew
```

### Cấu hình CDP port (tuỳ chọn)

Thêm vào `.env` nếu muốn đổi port hoặc display:
```
CDP_PORT=9222
DISPLAY_NUM=99
LOGIN_TIMEOUT_MS=600000
```

## Usage

### Scrape Facebook Page Posts
```bash
node scripts/facebook_feed.js "https://www.facebook.com/pagename" "6"
```

### Scrape with Vision AI
```bash
node scripts/facebook_feed_vision.js "https://www.facebook.com/pagename" "10"
```

### Facebook Ads Library Discovery
```bash
node scripts/facebook_ads_library.js "tên page" "5"
```

### TikTok Channel Analytics
```bash
node scripts/tiktok/analytic.js "uniqueId"
```

### Video Transcript
```bash
python scripts/video_transcript.py "url_video"
```

## Session Storage

Session được lưu ở 2 nơi (đồng bộ tự động):

| Vị trí | Format | Dùng bởi |
|--------|--------|----------|
| `.openclaw/fb_session.json` | Playwright storageState JSON | `facebook_feed.js` |
| `browser-data/` | Chromium persistent profile | `facebook_ads_library.js` |

### Schema của fb_session.json

```json
{
  "cookies": [
    {
      "name": "c_user",
      "value": "<facebook_user_id>",
      "domain": ".facebook.com",
      "expires": 1811395589
    }
  ],
  "origins": [
    {
      "origin": "https://www.facebook.com",
      "localStorage": []
    }
  ]
}
```

## Output Format

```json
{
  "platform": "facebook",
  "url": "<scraped_url>",
  "timestamp": "<ISO_timestamp>",
  "posts": [
    {
      "id": "<post_id>",
      "content": "<post_content>",
      "timestamp": "<post_timestamp>",
      "likes": 123,
      "comments": [],
      "shares": 45
    }
  ],
  "page_info": {
    "name": "<page_name>",
    "followers": 12345,
    "likes": 0
  }
}
```

## Troubleshooting

### Session hết hạn
```bash
# Kiểm tra trạng thái
node scripts/session_generator.js --check

# Renew session
node scripts/session_generator.js --force
```

### Không thể mở browser trên server
```bash
# Cài Xvfb (nếu chưa có)
sudo apt-get install -y xvfb

# Kiểm tra Xvfb
which Xvfb
```

### Scraper báo "Session đã hết hạn"
Scraper sẽ tự động mở browser trên server và cấp link (CDP) cho bạn login.
Tuy nhiên, nếu bạn muốn renew thủ công trước khi chạy scraper:
```bash
node scripts/session_generator.js --force
```

### Debug logs
- Session log: `debug/session.log`
- Error log: `.openclaw/scraper_errors.log`
- AI responses: `debug/ai_raw_*.txt`
- GraphQL data: `debug/graphql_response_*.json`

## Security Notes

- Never commit `.env` file to git
- Session file chứa cookies nhạy cảm — không commit
- Dùng `.gitignore` để loại trừ `.openclaw/`, `browser-data/`, `debug/`
