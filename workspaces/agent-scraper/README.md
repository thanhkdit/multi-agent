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

2. Edit `.env` and add your Facebook credentials:
```
FACEBOOK_EMAIL=your_actual_email@example.com
FACEBOOK_PASSWORD=your_actual_password
FACEBOOK_PAGE_URL=https://www.facebook.com/eyeplus.vn
SESSION_PATH=./.openclaw/facebook_session.json
HEADLESS=true
DEBUG=false
```

## Usage

Run the scraper:
```bash
node facebook_scraper.js
```

The scraper will:
1. Login to Facebook (or reuse saved session)
2. Navigate to the target page
3. Extract posts, comments, likes, and page info
4. Output JSON to stdout

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

## Session Management

- Sessions are saved to `.openclaw/facebook_session.json`
- This avoids repeated logins
- Delete the session file to force re-login

## Security Notes

- Never commit `.env` file to git
- Keep credentials secure
- Use app-specific passwords if available
- Be aware of Facebook's rate limits and terms of service

## Troubleshooting

If scraping fails:
1. Check credentials in `.env`
2. Try with `HEADLESS=false` to see browser
3. Check `.openclaw/scraper_errors.log` for errors
4. Facebook may require CAPTCHA or 2FA - handle manually in non-headless mode
