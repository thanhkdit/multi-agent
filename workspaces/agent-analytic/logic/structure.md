-- =================================================================================
-- 1. BẢNG RAW DATA: NETWORK ADS
-- Nguồn dữ liệu từ Facebook Ads, Google Ads, TikTok Ads, Apple Search Ads...
-- =================================================================================
CREATE TABLE ads_reports.network_ads_hourly
(
    `report_hour` DateTime,             -- Khung giờ ghi nhận dữ liệu
    `source` LowCardinality(String),    -- Nền tảng (vd: 'facebook ads', 'google ads')
    `account_id` String,                -- ID tài khoản quảng cáo
    `account_name` String,              -- Tên tài khoản quảng cáo
    `campaign_id` String,               -- ID chiến dịch
    `campaign_name` String,             -- Tên chiến dịch
    `adgroup_id` String,                -- ID nhóm quảng cáo (Adset / Adgroup)
    `adgroup_name` String,              -- Tên nhóm quảng cáo
    `ad_id` String,                     -- ID mẫu quảng cáo (Ad)
    `ad_name` String,                   -- Tên mẫu quảng cáo
    `impressions` UInt32 DEFAULT 0,     -- Lượt hiển thị
    `clicks` UInt32 DEFAULT 0,          -- Lượt click
    `spend` Float64 DEFAULT 0.,         -- Chi phí quảng cáo đã tiêu thụ
    `reach` UInt32 DEFAULT 0,           -- Lượng tiếp cận người dùng độc nhất
    `conversions` UInt32 DEFAULT 0,     -- Lượt chuyển đổi ghi nhận trên Network
    `extra_metrics` Map(String, Float64),-- Các chỉ số phụ khác (tuỳ chọn)
    `created_at` DateTime DEFAULT now(),-- Giờ dòng dữ liệu được kéo về
    `updated_at` DateTime DEFAULT now() -- Giờ dòng dữ liệu được cập nhật lại
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(report_hour)
ORDER BY (source, campaign_id, ad_id, report_hour)
SETTINGS index_granularity = 8192;

-- =================================================================================
-- 2. BẢNG RAW DATA: GOOGLE ANALYTICS 4 (GA4)
-- Nguồn dữ liệu đối soát traffic, hành vi người dùng trên website/app
-- =================================================================================
CREATE TABLE ads_reports.ga4_hourly
(
    `report_hour` DateTime,             -- Khung giờ ghi nhận
    `session_source` LowCardinality(String), -- Nguồn traffic (google, facebook...)
    `session_campaign_name` String,     -- UTM Campaign
    `session_manual_ad_content` String, -- UTM Content (thường map với Ad Name)
    `ad_id` String,                     -- ID mẫu quảng cáo bóc tách từ tham số
    `active_users` UInt32 DEFAULT 0,    -- Số lượng người dùng hoạt động thật
    `engaged_sessions` UInt32 DEFAULT 0,-- Phiên tương tác (bỏ qua những phiên thoát ngay)
    `created_at` DateTime DEFAULT now(),
    `updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(report_hour)
ORDER BY (session_source, session_campaign_name, ad_id, report_hour)
SETTINGS index_granularity = 8192;

-- =================================================================================
-- 3. BẢNG RAW DATA: MMP (MOBILE MEASUREMENT PARTNER)
-- Nguồn dữ liệu Tracking App (Adjust, AppsFlyer) ghi nhận install, in-app event
-- =================================================================================
CREATE TABLE ads_reports.mmp_hourly
(
    `report_hour` DateTime,             -- Khung giờ ghi nhận
    `source` LowCardinality(String),    -- Tên MMP (appsflyer, adjust)
    `attribution_type` LowCardinality(String), -- Loại ghi nhận (install, re-engagement...)
    `campaign_id` String,               
    `campaign_name` String,             
    `adgroup_id` String,                
    `adgroup_name` String,              
    `ad_id` String,                     
    `ad_name` String,                   
    `impressions` UInt32 DEFAULT 0,     -- Lượt xem (nếu MMP có track)
    `clicks` UInt32 DEFAULT 0,          -- Lượt click (qua link MMP)
    `installs` UInt32 DEFAULT 0,        -- Lượt cài đặt app thành công
    `re_attributions` UInt32 DEFAULT 0, -- Lượt ghi nhận lại thiết bị cũ
    `re_engagements` UInt32 DEFAULT 0,  -- Lượt mở lại app qua ads (retargeting)
    `total_events` UInt32 DEFAULT 0,    -- Tổng số sự kiện in-app đã xảy ra
    `cost` Float64 DEFAULT 0.,          -- Chi phí ước tính truyền qua API MMP
    `revenue` Float64 DEFAULT 0.,       -- Doanh thu thực tế mang về (In-app purchase)
    `custom_events` Map(String, Float64),
    `created_at` DateTime DEFAULT now(),
    `updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(report_hour)
ORDER BY (source, attribution_type, campaign_id, ad_id, report_hour)
SETTINGS index_granularity = 8192;

-- =================================================================================
-- 4. BẢNG CHUẨN HOÁ: FACT TABLE (ADS HOURLY FACT)
-- Là điểm gom chung dữ liệu từ cả 3 nguồn (Network, MMP, GA4) về một cấu trúc duy nhất
-- thông qua các Materialized Views để dễ dàng truy vấn và làm báo cáo.
-- =================================================================================
CREATE TABLE ads_reports.ads_hourly_fact
(
    `report_hour` DateTime,             -- Khung giờ tổng hợp chung
    `source` LowCardinality(String),    -- Nguồn cấp dữ liệu gốc
    `session_source` String,            -- (Dùng cho GA4) Nguồn session
    `entity_level` Enum8('ad' = 1, 'adgroup' = 2), -- Đánh dấu dòng này là dữ liệu của level Ad hay level Adgroup
    `entity_key` String,                -- [QUAN TRỌNG] Khoá chính để nối các bảng. Được tạo bằng cách ghép Campaign Name + Ad Name.
    `entity_name` String,               -- Tên thực tế của Ad/Adgroup
    `campaign_id` String,               
    `campaign_name` String,             
    `adgroup_id` String,                
    `adgroup_name` String,              
    `ad_id` String,                     
    `ad_name` String,                   
    `impressions` UInt32 DEFAULT 0,     
    `clicks` UInt32 DEFAULT 0,          
    `spend` Float64 DEFAULT 0,          
    `installs` UInt32 DEFAULT 0,        
    `re_attributions` UInt32 DEFAULT 0, 
    `re_engagements` UInt32 DEFAULT 0,  
    `total_events` UInt32 DEFAULT 0,    
    `revenue` Float64 DEFAULT 0,        
    `conversions` UInt32 DEFAULT 0,     
    `active_users` UInt32 DEFAULT 0,    
    `engaged_sessions` UInt32 DEFAULT 0,
    `source_table` LowCardinality(String), -- Ghi chú lại dòng này chạy từ bảng gốc nào ra
    `created_at` DateTime DEFAULT now(),
    `updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(report_hour)
ORDER BY (source, entity_level, entity_key, report_hour)
SETTINGS index_granularity = 8192;

-- =================================================================================
-- 5. BẢNG ĐƯỜNG CƠ SỞ: BASELINE
-- Cập nhật mỗi ngày lúc 3h sáng để tính mức "bình thường" của 7, 30 ngày qua
-- =================================================================================
CREATE TABLE ads_reports.ad_baseline_hourly
(
    `source` String,
    `entity_key` String,                -- Khoá chiến dịch/Ad cần đo
    `entity_name` String,               
    `hour_of_day` UInt8,                -- Giờ trong ngày (0 -> 23). Giúp loại bỏ nhiễu giữa ban ngày và ban đêm.
    `avg_clicks` Float64,               -- Lượt Click trung bình khung giờ đó 7 ngày qua
    `std_clicks` Float64,               -- Độ lệch chuẩn Clicks (phục vụ Z-score)
    `avg_spend` Float64,                
    `std_spend` Float64,                
    `avg_installs` Float64,             
    `std_installs` Float64,             
    `avg_revenue` Float64,              
    `std_revenue` Float64,              
    `avg_cvr` Float64,                  
    `std_cvr` Float64,                  
    `avg_roas` Float64,                 
    `std_roas` Float64,                 
    `sample_days` UInt16,               -- Số ngày có dữ liệu thực tế (>=7 thì Z-score mới có ý nghĩa)
    `baseline_start_date` Date,         -- Quét dữ liệu từ ngày nào
    `baseline_end_date` Date,           -- Đến ngày nào
    `baseline_type` LowCardinality(String), -- Loại baseline ('7d', '30d')
    `updated_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (source, entity_key, hour_of_day)
SETTINGS index_granularity = 8192;

-- =================================================================================
-- 6. BẢNG CHỨA KẾT QUẢ PHÁT HIỆN BẤT THƯỜNG (ANOMALY)
-- Nơi N8N đẩy những bản ghi lỗi vào để chờ AI đánh giá.
-- Đã cấu hình TTL tự dọn rác sau 30 ngày.
-- =================================================================================
CREATE TABLE ads_reports.anomaly_candidates
(
    `detected_at` DateTime DEFAULT now(), -- Thời điểm phát hiện ra lỗi
    `report_hour` DateTime,               -- Giờ xảy ra lỗi
    `source` String,
    `entity_key` String,
    `entity_name` String,
    `anomaly_type` LowCardinality(String),-- Phân loại cảnh báo (spend_spike, click_drop...)
    `severity` LowCardinality(String),    -- Mức độ nghiêm trọng sơ bộ (critical, high)
    `current_clicks` Float64,             -- Số liệu lỗi hiện tại
    `baseline_clicks` Float64,            -- Số liệu bình thường (baseline) để so sánh
    `current_installs` Float64,
    `baseline_installs` Float64,
    `current_revenue` Float64,
    `baseline_revenue` Float64,
    `current_cvr` Float64,
    `baseline_cvr` Float64,
    `current_roas` Float64,
    `baseline_roas` Float64,
    `deviation_ratio` Float64,            -- Độ lệch chuẩn hiện tại (ABS của Z-score)
    `ai_status` UInt8 DEFAULT 0           -- 0 = Chờ xử lý, 1 = Đã gửi AI thành công
)
ENGINE = MergeTree
ORDER BY (detected_at, source, entity_key)
TTL detected_at + INTERVAL 30 DAY         -- Tự dọn dẹp các cảnh báo cũ
SETTINGS index_granularity = 8192;

-- =================================================================================
-- CÁC MATERIALIZED VIEWS ĐỂ ĐẨY DATA THÔ VÀO BẢNG FACT
-- =================================================================================
CREATE MATERIALIZED VIEW ads_reports.mv_ga4_to_fact TO ads_reports.ads_hourly_fact
-- ... (Giữ nguyên cấu trúc cột)
AS SELECT
    report_hour,
    'ga4' AS source,
    session_source,
    'ad' AS entity_level,
    lowerUTF8(trimBoth(replaceRegexpAll(concat(session_campaign_name, '|', coalesce(nullIf(session_manual_ad_content, ''), nullIf(ad_id, ''), nullIf(session_campaign_name, ''))), '\\s+', ' '))) AS entity_key,
    coalesce(nullIf(session_manual_ad_content, ''), nullIf(ad_id, ''), nullIf(session_campaign_name, '')) AS entity_name,
    '' AS campaign_id,
    session_campaign_name AS campaign_name,
    '' AS adgroup_id,
    '' AS adgroup_name,
    ad_id,
    session_manual_ad_content AS ad_name,
    0 AS impressions,
    0 AS clicks,
    0 AS spend,
    0 AS installs,
    0 AS re_attributions,
    0 AS re_engagements,
    0 AS total_events,
    0 AS revenue,
    0 AS conversions,
    active_users,
    engaged_sessions,
    'ga4_hourly' AS source_table,
    created_at,
    updated_at
FROM ads_reports.ga4_hourly;

CREATE MATERIALIZED VIEW ads_reports.mv_mmp_to_fact TO ads_reports.ads_hourly_fact
-- ... (Giữ nguyên cấu trúc cột)
AS SELECT
    report_hour,
    source,
    'ad' AS entity_level,
    lowerUTF8(trimBoth(replaceRegexpAll(concat(campaign_name, '|', ad_name), '\\s+', ' '))) AS entity_key,
    ad_name AS entity_name,
    campaign_id,
    campaign_name,
    adgroup_id,
    adgroup_name,
    ad_id,
    ad_name,
    impressions,
    clicks,
    cost AS spend,
    installs,
    re_attributions,
    re_engagements,
    total_events,
    revenue,
    0 AS conversions,
    0 AS active_users,
    0 AS engaged_sessions,
    'mmp_hourly' AS source_table,
    created_at,
    updated_at
FROM ads_reports.mmp_hourly;

CREATE MATERIALIZED VIEW ads_reports.mv_network_to_fact TO ads_reports.ads_hourly_fact
-- ... (Giữ nguyên cấu trúc cột)
AS SELECT
    report_hour,
    source,
    if(source = 'google ads', 'adgroup', 'ad') AS entity_level,
    lowerUTF8(trimBoth(replaceRegexpAll(concat(campaign_name, '|', if(source = 'google ads', adgroup_name, ad_name)), '\\s+', ' '))) AS entity_key,
    if(source = 'google ads', adgroup_name, ad_name) AS entity_name,
    campaign_id,
    campaign_name,
    adgroup_id,
    adgroup_name,
    ad_id,
    ad_name,
    impressions,
    clicks,
    0 AS spend,
    0 AS installs,
    0 AS re_attributions,
    0 AS re_engagements,
    0 AS total_events,
    0 AS revenue,
    conversions,
    0 AS active_users,
    0 AS engaged_sessions,
    'network_ads_hourly' AS source_table,
    created_at,
    updated_at
FROM ads_reports.network_ads_hourly;

-- =================================================================================
-- VIEWS BÁO CÁO VÀ PHÂN TÍCH LỖI
-- =================================================================================
CREATE VIEW ads_reports.v_ads_hourly_report
(
    -- Cấu trúc View Tính Toán Các Chỉ Số Cuối Cùng Dựa Trên Ads_Hourly_Fact
    `report_hour` DateTime,
    `source` LowCardinality(String),
    `entity_level` Enum8('ad' = 1, 'adgroup' = 2),
    `entity_key` String,
    `entity_name` String,
    `campaign_id` String,
    `campaign_name` String,
    `adgroup_id` String,
    `adgroup_name` String,
    `ad_id` String,
    `ad_name` String,
    `impressions` UInt64,
    `clicks` UInt64,
    `spend` Float64,
    `installs` UInt64,
    `re_attributions` UInt64,
    `re_engagements` UInt64,
    `total_events` UInt64,
    `revenue` Float64,
    `conversions` UInt64,
    `active_users` UInt64,
    `engaged_sessions` UInt64,
    `ctr` Nullable(Float64),
    `cvr` Nullable(Float64),
    `cpc` Nullable(Float64),
    `cpm` Nullable(Float64),
    `cpi` Nullable(Float64),
    `roas` Nullable(Float64),
    `ga4_click_ratio` Nullable(Float64)
)
AS SELECT
    report_hour,
    source,
    entity_level,
    entity_key,
    any(entity_name) AS entity_name,
    any(campaign_id) AS campaign_id,
    any(campaign_name) AS campaign_name,
    any(adgroup_id) AS adgroup_id,
    any(adgroup_name) AS adgroup_name,
    any(ad_id) AS ad_id,
    any(ad_name) AS ad_name,
    sum(impressions) AS impressions,
    sum(clicks) AS clicks,
    sum(spend) AS spend,
    sum(installs) AS installs,
    sum(re_attributions) AS re_attributions,
    sum(re_engagements) AS re_engagements,
    sum(total_events) AS total_events,
    sum(revenue) AS revenue,
    sum(conversions) AS conversions,
    sum(active_users) AS active_users,
    sum(engaged_sessions) AS engaged_sessions,
    round(clicks / nullIf(impressions, 0), 6) AS ctr,
    round(installs / nullIf(clicks, 0), 6) AS cvr,
    round(spend / nullIf(clicks, 0), 6) AS cpc,
    round((spend / nullIf(impressions, 0)) * 1000, 6) AS cpm,
    round(spend / nullIf(installs, 0), 6) AS cpi,
    round(revenue / nullIf(spend, 0), 6) AS roas,
    round(active_users / nullIf(clicks, 0), 6) AS ga4_click_ratio
FROM ads_reports.ads_hourly_fact
GROUP BY
    report_hour,
    source,
    entity_level,
    entity_key;

-- VIEW SO SÁNH Z-SCORE BẰNG CÁCH JOIN REPORT VIEW VỚI BASELINE
CREATE VIEW ads_reports.v_anomaly_zscore
(
    `report_hour` DateTime,
    `source` LowCardinality(String),
    `entity_level` Enum8('ad' = 1, 'adgroup' = 2),
    `entity_key` String,
    `entity_name` String,
    `campaign_id` String,
    `campaign_name` String,
    `adgroup_id` String,
    `adgroup_name` String,
    `ad_id` String,
    `ad_name` String,
    `impressions` UInt64,
    `clicks` UInt64,
    `spend` Float64,
    `installs` UInt64,
    `re_attributions` UInt64,
    `re_engagements` UInt64,
    `total_events` UInt64,
    `revenue` Float64,
    `conversions` UInt64,
    `active_users` UInt64,
    `engaged_sessions` UInt64,
    `ctr` Nullable(Float64),
    `cvr` Nullable(Float64),
    `cpc` Nullable(Float64),
    `cpm` Nullable(Float64),
    `cpi` Nullable(Float64),
    `roas` Nullable(Float64),
    `ga4_click_ratio` Nullable(Float64),
    `sample_days` UInt16,
    `baseline_type` LowCardinality(String),
    `avg_clicks` Float64,
    `std_clicks` Float64,
    `avg_spend` Float64,
    `std_spend` Float64,
    `avg_installs` Float64,
    `std_installs` Float64,
    `avg_revenue` Float64,
    `std_revenue` Float64,
    `avg_cvr` Float64,
    `std_cvr` Float64,
    `avg_roas` Float64,
    `std_roas` Float64,
    `clicks_zscore` Nullable(Float64),
    `installs_zscore` Nullable(Float64),
    `cvr_zscore` Nullable(Float64),
    `roas_zscore` Nullable(Float64),
    `spend_zscore` Nullable(Float64),    -- [MỚI THÊM] Đo độ lệch ngân sách
    `revenue_zscore` Nullable(Float64)   -- [MỚI THÊM] Đo độ lệch doanh thu
)
AS SELECT
    r.*,
    b.sample_days,
    b.baseline_type,
    b.avg_clicks,
    b.std_clicks,
    b.avg_spend,
    b.std_spend,
    b.avg_installs,
    b.std_installs,
    b.avg_revenue,
    b.std_revenue,
    b.avg_cvr,
    b.std_cvr,
    b.avg_roas,
    b.std_roas,
    round((r.clicks - b.avg_clicks) / nullIf(b.std_clicks, 0), 2) AS clicks_zscore,
    round((r.installs - b.avg_installs) / nullIf(b.std_installs, 0), 2) AS installs_zscore,
    round((r.cvr - b.avg_cvr) / nullIf(b.std_cvr, 0), 2) AS cvr_zscore,
    round((r.roas - b.avg_roas) / nullIf(b.std_roas, 0), 2) AS roas_zscore,
    round((r.spend - b.avg_spend) / nullIf(b.std_spend, 0), 2) AS spend_zscore,
    round((r.revenue - b.avg_revenue) / nullIf(b.std_revenue, 0), 2) AS revenue_zscore
FROM ads_reports.v_ads_hourly_report AS r
LEFT JOIN ads_reports.ad_baseline_hourly AS b 
    ON (r.source = b.source) 
    AND (r.entity_key = b.entity_key) 
    AND (toHour(r.report_hour) = b.hour_of_day) 
    AND (b.baseline_type = '7d');