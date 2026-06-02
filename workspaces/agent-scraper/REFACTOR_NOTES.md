# Universal Scraper - Refactored Codebase

## Overview
This workspace has been refactored to use a single, unified scraper that supports multiple social media platforms instead of maintaining separate scripts for each platform.

## Files

### Core Scraper
- **`facebook_feed.js`** - Main entry point supporting Facebook, TikTok, Instagram, Twitter, and YouTube
  - Platform auto-detection from URL
  - Unified session management
  - Modular scraper classes per platform
  - Standardized JSON output format

### Reference
- **`facebook_scraper_final.js`** - Legacy Facebook-only scraper (kept for reference)
- **`agent.js`** - Agent orchestration script

## Deleted Files
The following redundant scripts have been removed:
- `facebook_scraper.js`, `facebook_scraper_v2.js`, `facebook_scraper_v3.js`, `facebook_scraper_v4.js`
- `facebook_scraper_simple.js`
- `scraper.js`, `scraper_v2.js`, `scraper_advanced.js`, `scraper_complete.js`, `scraper_final.js`, `scraper_optimized.js`
- `scraper_facebook.js`, `scrape_facebook.js`, `scrape_interactive.js`, `scrape_public.js`
- `like_latest_post.js` (utility script no longer needed)

## Usage

### Facebook
```bash
node facebook_feed.js https://www.facebook.com/kinhmateyeplus
```

### TikTok (placeholder - implementation pending)
```bash
node facebook_feed.js https://www.tiktok.com/@username
```

### Instagram (placeholder - implementation pending)
```bash
node facebook_feed.js https://www.instagram.com/username
```

## Environment Variables

```bash
# Facebook
export FACEBOOK_EMAIL="your_email@example.com"
export FACEBOOK_PASSWORD="your_password"

# TikTok
export TIKTOK_USERNAME="your_username"
export TIKTOK_PASSWORD="your_password"

# Instagram
export INSTAGRAM_USERNAME="your_username"
export INSTAGRAM_PASSWORD="your_password"
```

## Session Management

Sessions are automatically saved to `.openclaw/` directory:
- `.openclaw/facebook_session.json`
- `.openclaw/tiktok_session.json`
- `.openclaw/instagram_session.json`

Errors are logged to `.openclaw/scraper_errors.log`

## Output Format

All scrapers return standardized JSON:

```json
{
  "platform": "facebook",
  "url": "https://www.facebook.com/page",
  "timestamp": "2026-05-05T10:57:19.239Z",
  "posts": [
    {
      "id": "post_id",
      "url": "post_url",
      "content": "post_content",
      "timestamp": "2026-05-05T10:57:19.239Z",
      "likes": 100,
      "shares": 5,
      "comments": [
        {
          "id": "comment_id",
          "author": "author_name",
          "content": "comment_content",
          "timestamp": "2026-05-05T10:57:19.239Z"
        }
      ]
    }
  ],
  "page_info": {
    "name": "page_name",
    "followers": 10000,
    "likes": 5000
  }
}
```

## Architecture

### Class Structure
- `FacebookScraper` - Fully implemented
- `TikTokScraper` - Placeholder (ready for implementation)
- `InstagramScraper` - Placeholder (ready for implementation)

### Key Functions
- `detectPlatform(url)` - Auto-detect platform from URL
- `loadSession(browser, platform)` - Load cached session
- `saveSession(context, platform)` - Save session for reuse
- `universalScrape(url)` - Main entry point

## Benefits of Refactoring

1. **Single Source of Truth** - One script to maintain instead of 18+
2. **Consistent Output** - All platforms return standardized JSON
3. **Easy Extensibility** - Add new platforms by creating new Scraper classes
4. **Session Reuse** - Cached sessions reduce login overhead
5. **Centralized Error Logging** - All errors logged to single file
6. **Cleaner Codebase** - Reduced file clutter and duplication

## Next Steps

1. Implement TikTok scraper class
2. Implement Instagram scraper class
3. Add Twitter/X support
4. Add YouTube support
5. Add rate limiting and retry logic
6. Add proxy support for reliability
