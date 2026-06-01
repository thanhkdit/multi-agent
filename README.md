# OpenClaw Multi-Agent Facebook Intelligence System

## Overview

Hệ thống Multi-Agent xây dựng trên OpenClaw để:

- Discover Facebook pages/advertisers
- Crawl Facebook bằng browser automation
- Phân tích content/social/marketing
- Tách biệt rõ role giữa các agents
- Giảm hallucination bằng permission isolation

---

# Architecture

```text
User
  ↓
agent-orchestrator
  ↓
agent-discovery
  ↓
agent-scraper
  ↓
Raw Facebook Data
  ↓
agent-orchestrator
  ↓
Analysis / Summary
```

---

# Agents

## agent-orchestrator

### Role
- Giao tiếp với user
- Phân tích intent
- Điều phối sub-agents
- Tổng hợp & phân tích dữ liệu

### Forbidden
- scrape trực tiếp
- browser automation
- external APIs

---

## agent-discovery

### Role
- Tìm Facebook pages
- Resolve advertiser/pages
- Search qua Facebook Ads Library

### Sources
- Facebook Search
- Facebook Ads Library

### Forbidden
- marketing analysis
- post crawling
- business reasoning

---

## agent-scraper

### Role
- Browser automation
- Crawl Facebook posts
- Extract raw data

### Crawl Modes

| Mode | Purpose |
|---|---|
| latest_posts | bài mới nhất |
| engagement_scan | ưu tiên metrics |
| content_only | chỉ content |
| media_posts | ưu tiên media |
| full_posts | crawl tối đa |

### Forbidden
- strategy analysis
- recommendations
- summaries

---

# Workspace Structure

```text
openclaw-multi-agent/
├── workspaces/
│   ├── agent-orchestrator/
│   ├── agent-discovery/
│   └── agent-scraper/
├── agents/
├── configs/
└── scripts/
```

---

# Agent Files

```text
AGENTS.md
SOUL.md
TOOLS.md
```

| File | Purpose |
|---|---|
| AGENTS.md | workflow & objective |
| SOUL.md | behavior & constraints |
| TOOLS.md | permissions & tool rules |

---

# Browser Automation

- Playwright
- Persistent Context
- Human-like typing
- Session reuse

Browser session được lưu tại:

```text
browser-data/
```

---

# Discovery Flow

```text
Open Ads Library
  ↓
Type keyword
  ↓
Extract advertiser/page candidates
  ↓
Return confidence-scored results
```

---

# Example Flow

## Query

```text
tìm các trang quảng cáo của Bảo Tín Mạnh Hải
```

## Execution

```text
agent-orchestrator
  ↓
agent-discovery
  ↓
Facebook Ads Library
  ↓
candidate pages
  ↓
optional confirmation
  ↓
agent-scraper
```

---

# Confidence-based Confirmation

Nếu confidence thấp:

```text
< 80
```

orchestrator sẽ confirm lại URL với user.

---

# Example Commands

## Discovery

```bash
node scripts/facebook_discovery.js ads_library_lookup "Bảo Tín Mạnh Hải"
```

## Scraping

```bash
node scripts/universal_scraper.js "https://facebook.com/abc" "10" "full_posts"
```

---

# Design Principles

- Facebook-first
- Strict role separation
- Human-like automation
- Raw-data isolation
- Confidence-based routing

---

# Security

Không commit:

```gitignore
browser-data/
*.session
cookies.json
```