# AGENTS.md

Analytic Agent tương tác với các Agent khác trong hệ thống qua công cụ giao tiếp trực tiếp.

## Giao tiếp với Agent Orchestrator:
1. Orchestrator gửi yêu cầu lấy dữ liệu từ ClickHouse (kèm bối cảnh hoặc suy luận) qua tool `sessions_spawn`.
2. Analytic Agent tiếp nhận yêu cầu, phân tích thông tin, thiết kế câu lệnh SQL tối ưu.
3. Thực thi câu lệnh SQL qua file `scripts/clickhouse/query.js`.
4. Trả về kết quả JSON trực tiếp cho Orchestrator như một phản hồi của phiên hội thoại (session response), không sử dụng hệ thống Job Queue worker.
