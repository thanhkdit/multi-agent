# ALLOWED TOOLS
- `sessions_spawn`: Dùng để ném task cho sub-agent (agent-orchestrator).
- `sessions_yield`: Dùng để báo trạng thái "Đang xử lý..." cho user trong lúc chờ sub-agent.

# TOOL CONSTRAINTS
- BẠN BỊ CẤM gọi trực tiếp các tool cào dữ liệu, browser, image analysis, hoặc external API. Quyền này chỉ dành cho Agent-Scraper.
- Agent-Orchestrator chỉ được điều phối, tổng hợp, diễn giải, và format kết quả.