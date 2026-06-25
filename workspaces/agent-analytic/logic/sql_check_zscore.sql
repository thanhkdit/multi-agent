-- Install drop:
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at,
    report_hour,
    source,
    entity_key,
    entity_name,
    anomaly_type,
    severity,
    current_clicks,
    baseline_clicks,
    current_installs,
    baseline_installs,
    current_revenue,
    baseline_revenue,
    current_cvr,
    baseline_cvr,
    current_roas,
    baseline_roas,
    deviation_ratio,
    ai_status
)
SELECT
    now(),
    report_hour,
    source,
    entity_key,
    entity_name,
    'install_drop_zscore' as install_drop_zscore,
    if(installs_zscore <= -5, 'critical', 'high') as warning,

    clicks,
    avg_clicks,

    installs,
    avg_installs,

    revenue,
    avg_revenue,

    cvr,
    avg_cvr,

    roas,
    avg_roas,

    abs(installs_zscore),

    0
FROM ads_reports.v_anomaly_zscore
WHERE
    sample_days >= 7
    AND baseline_type = '7d'
    AND installs_zscore <= -3
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);

-- CVR drop:
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at,
    report_hour,
    source,
    entity_key,
    entity_name,
    anomaly_type,
    severity,
    current_clicks,
    baseline_clicks,
    current_installs,
    baseline_installs,
    current_revenue,
    baseline_revenue,
    current_cvr,
    baseline_cvr,
    current_roas,
    baseline_roas,
    deviation_ratio,
    ai_status
)
SELECT
    now(),
    report_hour,
    source,
    entity_key,
    entity_name,
    'cvr_drop_zscore',
    if(cvr_zscore <= -5, 'critical', 'high'),

    clicks,
    avg_clicks,

    installs,
    avg_installs,

    revenue,
    avg_revenue,

    cvr,
    avg_cvr,

    roas,
    avg_roas,

    abs(cvr_zscore),

    0
FROM ads_reports.v_anomaly_zscore
WHERE
    sample_days >= 7
    AND baseline_type = '7d'
    AND clicks >= 100
    AND cvr_zscore <= -3
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);

-- ROAS Drop:
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at,
    report_hour,
    source,
    entity_key,
    entity_name,
    anomaly_type,
    severity,
    current_clicks,
    baseline_clicks,
    current_installs,
    baseline_installs,
    current_revenue,
    baseline_revenue,
    current_cvr,
    baseline_cvr,
    current_roas,
    baseline_roas,
    deviation_ratio,
    ai_status
)
SELECT
    now(),
    report_hour,
    source,
    entity_key,
    entity_name,
    'roas_drop_zscore',
    if(roas_zscore <= -5, 'critical', 'high'),

    clicks,
    avg_clicks,

    installs,
    avg_installs,

    revenue,
    avg_revenue,

    cvr,
    avg_cvr,

    roas,
    avg_roas,

    abs(roas_zscore),

    0
FROM ads_reports.v_anomaly_zscore
WHERE
    sample_days >= 7
    AND baseline_type = '7d'
    AND roas_zscore <= -3
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);


-- Click spike:
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at,
    report_hour,
    source,
    entity_key,
    entity_name,
    anomaly_type,
    severity,
    current_clicks,
    baseline_clicks,
    current_installs,
    baseline_installs,
    current_revenue,
    baseline_revenue,
    current_cvr,
    baseline_cvr,
    current_roas,
    baseline_roas,
    deviation_ratio,
    ai_status
)
SELECT
    now(),
    report_hour,
    source,
    entity_key,
    entity_name,
    'click_spike_zscore',
    if(clicks_zscore >= 5, 'critical', 'high'),

    clicks,
    avg_clicks,

    installs,
    avg_installs,

    revenue,
    avg_revenue,

    cvr,
    avg_cvr,

    roas,
    avg_roas,

    abs(clicks_zscore),

    0
FROM ads_reports.v_anomaly_zscore
WHERE
    sample_days >= 7
    AND baseline_type = '7d'
    AND clicks_zscore >= 3
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);


-- 1. SPEND SPIKE (Bão Tiêu Tiền - Chi phí tăng vọt)
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at, report_hour, source, entity_key, entity_name,
    anomaly_type, severity, current_clicks, baseline_clicks,
    current_installs, baseline_installs, current_revenue, baseline_revenue,
    current_cvr, baseline_cvr, current_roas, baseline_roas,
    deviation_ratio, ai_status
)
SELECT
    now(), report_hour, source, entity_key, entity_name,
    'spend_spike_zscore', 
    if(spend_zscore >= 5, 'critical', 'high'),
    clicks, avg_clicks, installs, avg_installs, revenue, avg_revenue,
    cvr, avg_cvr, roas, avg_roas,
    abs(spend_zscore), 0
FROM ads_reports.v_anomaly_zscore
WHERE sample_days >= 7 
  AND baseline_type = '7d' 
  AND spend_zscore >= 3
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);


-- 2. REVENUE DROP (Doanh thu sụt giảm mạnh đột ngột)
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at, report_hour, source, entity_key, entity_name,
    anomaly_type, severity, current_clicks, baseline_clicks,
    current_installs, baseline_installs, current_revenue, baseline_revenue,
    current_cvr, baseline_cvr, current_roas, baseline_roas,
    deviation_ratio, ai_status
)
SELECT
    now(), report_hour, source, entity_key, entity_name,
    'revenue_drop_zscore', 
    if(revenue_zscore <= -5, 'critical', 'high'),
    clicks, avg_clicks, installs, avg_installs, revenue, avg_revenue,
    cvr, avg_cvr, roas, avg_roas,
    abs(revenue_zscore), 0
FROM ads_reports.v_anomaly_zscore
WHERE sample_days >= 7 
  AND baseline_type = '7d' 
  AND avg_revenue > 0 -- Chỉ check với các ad thường xuyên có doanh thu
  AND revenue_zscore <= -3
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);


-- 3. CLICK DROP (Rớt Traffic đột ngột, tài khoản có thể bị khóa hoặc hết tiền)
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at, report_hour, source, entity_key, entity_name,
    anomaly_type, severity, current_clicks, baseline_clicks,
    current_installs, baseline_installs, current_revenue, baseline_revenue,
    current_cvr, baseline_cvr, current_roas, baseline_roas,
    deviation_ratio, ai_status
)
SELECT
    now(), report_hour, source, entity_key, entity_name,
    'click_drop_zscore', 
    if(clicks_zscore <= -5, 'critical', 'high'),
    clicks, avg_clicks, installs, avg_installs, revenue, avg_revenue,
    cvr, avg_cvr, roas, avg_roas,
    abs(clicks_zscore), 0
FROM ads_reports.v_anomaly_zscore
WHERE sample_days >= 7 
  AND baseline_type = '7d' 
  AND avg_clicks > 50  -- Chỉ check nếu bthg ad có kha khá lượng click
  AND clicks_zscore <= -3
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);


-- 4. TRAFFIC MISMATCH (Dấu hiệu Bot Click hoặc đứt Tracking - Rule Cứng)
-- Không dùng z-score, dựa vào ga4_click_ratio
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at, report_hour, source, entity_key, entity_name,
    anomaly_type, severity, current_clicks, baseline_clicks,
    current_installs, baseline_installs, current_revenue, baseline_revenue,
    current_cvr, baseline_cvr, current_roas, baseline_roas,
    deviation_ratio, ai_status
)
SELECT
    now(), report_hour, source, entity_key, entity_name,
    'bot_traffic_mismatch', 
    'critical',
    clicks, avg_clicks, installs, avg_installs, revenue, avg_revenue,
    cvr, avg_cvr, roas, avg_roas,
    ga4_click_ratio, 0
FROM ads_reports.v_anomaly_zscore
WHERE clicks >= 100 
  AND ga4_click_ratio < 0.2
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);  -- Ít hơn 20% click thực sự vào được app/web


-- 5. NO CONVERSIONS (Đốt tiền nhưng không có số - Rule Cứng)
-- Hỗ trợ chặn tiêu ngân sách ngu ngốc khi chưa đủ lịch sử 7 ngày
INSERT INTO ads_reports.anomaly_candidates
(
    detected_at, report_hour, source, entity_key, entity_name,
    anomaly_type, severity, current_clicks, baseline_clicks,
    current_installs, baseline_installs, current_revenue, baseline_revenue,
    current_cvr, baseline_cvr, current_roas, baseline_roas,
    deviation_ratio, ai_status
)
SELECT
    now(), report_hour, source, entity_key, entity_name,
    'spend_without_conversion', 
    'critical',
    clicks, avg_clicks, installs, avg_installs, revenue, avg_revenue,
    cvr, avg_cvr, roas, avg_roas,
    spend, 0
FROM ads_reports.v_anomaly_zscore
WHERE spend >= 50       -- Ví dụ threshold là $50 (bạn có thể thay đổi)
  AND conversions = 0
  AND report_hour >= toStartOfHour(now() - INTERVAL 2 HOUR);