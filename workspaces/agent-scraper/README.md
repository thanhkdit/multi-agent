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

**Trên máy local (có GUI):**
```bash
ENV=local node scripts/session_generator.js
```

**Trên Ubuntu server (headless):**

1. Cài đặt dependencies cho remote login:
```bash
sudo apt-get install -y xvfb x11vnc
# (Tuỳ chọn) Để dùng web browser thay VNC client:
sudo apt-get install -y novnc websockify
```

2. Chạy session generator:
```bash
node scripts/session_generator.js
# hoặc
npm run session:login
```

3. Script sẽ tự khởi động:
   - **Xvfb**: Virtual display cho Chromium
   - **x11vnc**: VNC server để bạn kết nối từ xa
   - **noVNC** (nếu có): Web-based VNC client

4. Kết nối vào browser:
   - **VNC Client**: `vnc://<server_ip>:5900`
   - **Web Browser**: `http://<server_ip>:6080/vnc.html`

5. Login Facebook thủ công trên browser, giải CAPTCHA nếu có

6. Script tự phát hiện login thành công và lưu session

### Renew session khi hết hạn

```bash
node scripts/session_generator.js --force
# hoặc
npm run session:renew
```

### Cấu hình VNC ports (tuỳ chọn)

Thêm vào `.env` nếu muốn đổi port:
```
VNC_PORT=5900
NOVNC_PORT=6080
DISPLAY_NUM=99
LOGIN_TIMEOUT_MS=600000
```

## Usage

### Scrape Facebook Page Posts
```bash
node scripts/universal_scraper.js "https://www.facebook.com/pagename" "6"
```

### Scrape with Vision AI
```bash
node scripts/universal_scraper_vision.js "https://www.facebook.com/pagename" "10"
```

### Facebook Ads Library Discovery
```bash
node scripts/facebook_discovery.js "tên page" "5"
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
| `.openclaw/fb_session.json` | Playwright storageState JSON | `universal_scraper.js`, `universal_scraper_vision.js` |
| `browser-data/` | Chromium persistent profile | `facebook_discovery.js`, `facebook_discovery_vision.js` |

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
# Cài Xvfb + VNC
sudo apt-get install -y xvfb x11vnc

# Kiểm tra Xvfb
which Xvfb

# Kiểm tra x11vnc
which x11vnc
```

### Scraper báo "Session đã hết hạn"
Khi scraper trả về lỗi session, chạy:
```bash
node scripts/session_generator.js --force
```
Sau đó chạy lại lệnh scrape.

### Debug logs
- Session log: `debug/session.log`
- Error log: `.openclaw/scraper_errors.log`
- AI responses: `debug/ai_raw_*.txt`
- GraphQL data: `debug/graphql_response_*.json`

## Security Notes

- Never commit `.env` file to git
- Session file chứa cookies nhạy cảm — không commit
- Dùng `.gitignore` để loại trừ `.openclaw/`, `browser-data/`, `debug/`
