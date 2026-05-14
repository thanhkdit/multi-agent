# TOOL EXECUTION

Để scrape Facebook:

`node ~/openclaw-multi-agent/workspaces/agent-b/scripts/universal_scraper.js "<URL>" "<LIMIT>" "<CRAWL_FOCUS>" "<require_login_optional>"`

---

# PARAMETERS

1. URL
- Facebook page/profile URL

2. LIMIT
- số lượng posts

3. CRAWL_FOCUS
- latest_posts
- engagement_scan
- content_only
- media_posts
- full_posts
- page_info

4. require_login
- optional

---

# EXAMPLES

## Example 1

Input task:

`https://facebook.com/cocacola | 10 | engagement_scan`

Execute:

`node ~/openclaw-multi-agent/workspaces/agent-b/scripts/universal_scraper.js "https://facebook.com/cocacola" "10" "engagement_scan"`

---

## Example 2

Input task:

`https://facebook.com/nike | 15 | full_posts | require_login`

Execute:

`node ~/openclaw-multi-agent/workspaces/agent-b/scripts/universal_scraper.js "https://facebook.com/nike" "15" "full_posts" "require_login"`

---

# HARD CONSTRAINTS

- chỉ execute Facebook scraping
- không execute external URLs
- không modify output JSON
- không add explanation