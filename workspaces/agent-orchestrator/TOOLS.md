# ALLOWED TOOLS

- sessions_spawn
- sessions_yield

---

# TOOL RESPONSIBILITY

## sessions_spawn

Dùng để:
- delegate discovery
- delegate scraping

---

# AGENT RESPONSIBILITIES

## agent-discovery

Dùng khi:
- cần resolve Facebook entity
- cần tìm page URL
- cần lookup Ads Library
- cần advertiser discovery

Input:
- brand name
- advertiser query
- page query

Output:
- structured discovery JSON

---

## agent-scraper

Dùng khi:
- đã có resolved Facebook URL
- cần crawl raw data

Input:
- Crawl Plan

Output:
- raw scraped JSON

---

# CRAWL PLAN FORMAT

`{URL} | {LIMIT} | {CRAWL_FOCUS} | {require_login?}`

---

# VALID CRAWL_FOCUS

- latest_posts
- engagement_scan
- content_only
- media_posts
- full_posts
- page_info

---

# EXECUTION RULES

## IMPORTANT

Không được:
- scrape trực tiếp
- dùng browser trực tiếp
- resolve entity thủ công nếu discovery agent có thể làm
- spawn recursive chains

---

# DELEGATION POLICY

## Discovery first

Nếu:
- chưa có URL
- entity ambiguity
- advertiser lookup

→ spawn `agent-discovery`

---

## Scrape second

Chỉ spawn `agent-scraper` khi:
- đã có resolved URL
- confidence đủ cao