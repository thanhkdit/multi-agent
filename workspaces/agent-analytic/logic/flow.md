# LUỒNG VẬN HÀNH HỆ THỐNG REPORTING & ALERT (CẬP NHẬT)

Dưới đây là bản tổng hợp luồng vận hành thực tế của hệ thống sau khi đã bổ sung đầy đủ các Rule Cảnh báo và tích hợp AI.

## 1. MỤC TIÊU HỆ THỐNG
* **Lưu trữ tập trung**: Lưu toàn bộ dữ liệu quảng cáo (Network, MMP, GA4) theo từng giờ.
* **Chuẩn hóa (Data Warehouse)**: Đưa dữ liệu từ nhiều nguồn phân mảnh về cùng một cấu trúc (Fact Table) để dễ dàng join và làm báo cáo.
* **Định nghĩa mức Bình thường (Baseline)**: Tính toán trung bình và độ lệch chuẩn từ lịch sử 7 ngày (theo từng khung giờ cụ thể) để tạo ra quy chuẩn đánh giá.
* **Phát hiện Bất thường (Anomaly Detection)**: Tự động chạy 9 rules (kết hợp Z-score và Rule cứng) để bắt lỗi phân phối, lỗi tracking, bão tiêu tiền.
* **AI Đánh giá Rủi ro**: Dùng AI để làm "tấm khiên" lọc nhiễu (Ngày lễ, mega sale, cuối tuần) và diễn giải số liệu khô khan thành ngôn ngữ tự nhiên.
* **Gửi Cảnh báo Tiền trạm**: Bắn tin nhắn tự động ra Telegram/Slack dưới định dạng HTML dễ đọc và đề xuất ngay hành động cho team Media Buyer.

---

## 2. LUỒNG KIẾN TRÚC TỔNG THỂ

```text
(1) Dữ liệu Thô (Ingest hàng giờ từ API)
    ├── network_ads_hourly (Facebook, Google, Tiktok...)
    ├── mmp_hourly (AppsFlyer, Adjust)
    └── ga4_hourly (Google Analytics 4)
         ↓
(2) Chuẩn hóa (Tự động qua 3 Materialized Views)
    └── ads_hourly_fact
         ↓
(3) Report & Phân tích (ClickHouse Views)
    ├── v_ads_hourly_report (Tính CTR, CVR, CPC, CPM, CPI, ROAS...)
    └── v_anomaly_zscore (Join Report với Baseline để tính Z-Score)
         ↓
(4) Phát hiện Bất thường (N8N Job - Chạy mỗi giờ)
    └── anomaly_candidates (Nếu thoả mãn 1 trong 9 Rules SQL, insert vào đây)
         ↓
(5) Đánh giá AI & Gửi Alert (N8N Job - Chạy ngay sau bước 4)
    ├── N8N lấy Data từ anomaly_candidates (ai_status = 0)
    ├── AI đánh giá rủi ro (Nạp Context thời gian + JSON, xuất JSON)
    ├── Bắn Telegram/Slack Alert (HTML format)
    └── UPDATE ai_status = 1 (Khoá lại để giờ sau không báo trùng)
```

Song song đó, luồng bảo trì dữ liệu tĩnh:
```text
(6) Baseline Job - Chạy lúc 03:00 sáng mỗi ngày
    v_ads_hourly_report
         ↓
    ad_baseline_hourly (Lưu trung bình & độ lệch chuẩn của 7 ngày)
```

---

## 3. Ý NGHĨA CỦA 9 RULE CẢNH BÁO

1. **Install Drop**: Rớt số lượng cài đặt so với trung bình (`installs_zscore <= -3`).
2. **CVR Drop**: Clicks nhiều nhưng tỷ lệ chuyển đổi cài đặt rớt mạnh (`cvr_zscore <= -3`).
3. **ROAS Drop**: Doanh thu trên chi phí quảng cáo rớt mạnh (`roas_zscore <= -3`).
4. **Click Spike**: Lượng Click tăng vọt bất thường (`clicks_zscore >= 3`). Có thể là bot.
5. **Spend Spike (Bão tiêu tiền)**: Chi tiêu tăng đột ngột (`spend_zscore >= 3`). Lỗi cấu hình ngân sách hoặc thuật toán cắn tiền ảo.
6. **Revenue Drop**: Doanh thu đột ngột biến mất (`revenue_zscore <= -3`). Lỗi app hoặc lỗi tracking in-app purchase.
7. **Click Drop (Rớt traffic)**: Lượng Clicks giảm sát đáy (`clicks_zscore <= -3`). Bị khoá thẻ, hết tiền, hoặc Ads bị report.
8. **Traffic Mismatch (Rule cứng)**: Bất đồng bộ Tracking/Bot click (`ga4_click_ratio < 0.2`). Ads báo có click nhưng GA4 không thấy user.
9. **No Conversions (Rule cứng)**: Đốt tiền lớn nhưng chưa có chuyển đổi (Spend > 50 & Conv = 0). Chặn rỉ máu tài khoản.

---

## 4. QUY TRÌNH CHẠY N8N (WORKFLOW CỤ THỂ)

### A. Luồng chạy theo GIỜ (Hourly Alert Job)
Đây là luồng "canh gác" quan trọng nhất:
1. **Trigger**: Cron chạy vào phút thứ `05` hoặc `10` của mỗi giờ (Sau khi data thô đã kéo về xong).
2. **Execute SQL Rules**: Chạy 9 câu lệnh `INSERT INTO anomaly_candidates ...` để quét dữ liệu của đúng 1-2 giờ trước (Có lệnh `report_hour >= ...` để không lặp data).
3. **Fetch Unprocessed**: Select những bản ghi mới phát hiện: `SELECT * FROM anomaly_candidates WHERE ai_status = 0`.
4. **AI Assessment**: Gửi đống data này cho LLM (GPT-4o-mini / Gemini Flash) qua HTTP Request JSON Body để đánh giá mức độ rủi ro thực tế.
5. **Send Alert**: Bóc tách field `telegram_message` từ cục JSON của AI trả về và bắn lên Group Telegram.
6. **Acknowledge**: Chạy lệnh `ALTER TABLE anomaly_candidates UPDATE ai_status = 1 WHERE ai_status = 0` để khóa lại các cảnh báo, tránh bão tin nhắn vào giờ tiếp theo.

### B. Luồng chạy theo NGÀY (Daily Baseline Job)
1. **Trigger**: Cron lúc 03:00 sáng.
2. **Rebuild Baseline**: Chạy lệnh `TRUNCATE` và `INSERT` lại bảng `ad_baseline_hourly`. Bảng này phải cập nhật mỗi đêm để bộ Z-score của ngày hôm sau luôn có một khung tham chiếu "bình thường" được cập nhật sát với thực tế 7 ngày gần nhất.
