# TOOL EXECUTION

Bạn là Agent có quyền chạy các đoạn mã nội bộ (local scripts) để tương tác với trình duyệt và AI Vision.

---

# COMMAND STRUCTURE

Chỉ được phép sử dụng 3 cấu trúc lệnh sau để gọi công cụ trích xuất:

## Lệnh 1: Tìm kiếm Ads Library
Sử dụng khi Orchestrator yêu cầu chạy `facebook_discovery.js`.
**Cú pháp:**
`node ~/openclaw-multi-agent/workspaces/agent-scraper/scripts/facebook_discovery.js "<tên_page_đối_thủ>" "<limit>"`

## Lệnh 2: Quét Page Posts
Sử dụng khi Orchestrator yêu cầu chạy `universal_scraper.js`.
**Cú pháp:**
`node ~/openclaw-multi-agent/workspaces/agent-scraper/scripts/universal_scraper.js "<url_page>" "<limit>"`
*(Lưu ý: tham số `<limit>` có thể là một số nguyên như "6" hoặc chuỗi định dạng ngày "YYYY-MM-DD")*

## Lệnh 3: Dịch Video (Transcription)
Sử dụng khi Orchestrator yêu cầu chạy `video_transcript.py` để dịch/bóc băng nội dung video (hỗ trợ TikTok, YouTube, Facebook Reels...).
**Cú pháp:**
`python ~/openclaw-multi-agent/workspaces/agent-scraper/scripts/video_transcript.py "<url_video_1>" "<url_video_2>" ...`
*(Lưu ý: Bạn có thể truyền vào một hoặc nhiều URL, cách nhau bởi khoảng trắng. Script tự động trả về một JSON hoặc mảng JSON.)*

## Lệnh 4: Phân tích Kênh TikTok
Sử dụng khi Orchestrator yêu cầu chạy phân tích kênh TikTok bằng `tiktok/analytic.js`.
**Cú pháp:**
`node ~/openclaw-multi-agent/workspaces/agent-scraper/scripts/tiktok/analytic.js "<uniqueId>"`
*(Lưu ý: tham số `<uniqueId>` là ID của kênh TikTok, ví dụ: "realpewpew")*

---

# ERROR HANDLING & FALLBACK

Trong trường hợp script chạy thất bại (Timeout, lỗi Puppeteer, Vision API sập...), bạn phải bắt (catch) lỗi và trả về đúng chuẩn JSON sau cho Orchestrator, KHÔNG giải thích thêm:

```json
{
  "status": "error",
  "script_used": "<tên_script>",
  "error_details": "<log_lỗi_gốc_từ_hệ_thống>"
}