INSERT INTO ads_reports.ad_baseline_hourly
SELECT
    source,
    entity_key,
    any(entity_name) AS entity_name,

    toHour(report_hour) AS hour_of_day,

    avg(clicks) AS avg_clicks,
    stddevPop(clicks) AS std_clicks,

    avg(spend) AS avg_spend,
    stddevPop(spend) AS std_spend,

    avg(installs) AS avg_installs,
    stddevPop(installs) AS std_installs,

    avg(revenue) AS avg_revenue,
    stddevPop(revenue) AS std_revenue,

    avg(cvr) AS avg_cvr,
    stddevPop(cvr) AS std_cvr,

    avg(roas) AS avg_roas,
    stddevPop(roas) AS std_roas,

    countDistinct(toDate(report_hour)) AS sample_days,

    min(toDate(report_hour)) AS baseline_start_date,
    max(toDate(report_hour)) AS baseline_end_date,

    '7d' AS baseline_type,

    now() AS updated_at

FROM ads_reports.v_ads_hourly_report
WHERE report_hour >= now() - INTERVAL 7 DAY -- Hoặc 30 ngày
GROUP BY
    source,
    entity_key,
    hour_of_day;