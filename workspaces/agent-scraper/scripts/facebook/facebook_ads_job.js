#!/usr/bin/env node
const path = require("path");
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const {
  searchCompanyAndGetPageId,
  getCompanyAds
} = require("./facebook_ads_library");

require("dotenv").config({
  path: path.join(__dirname, "../../.env")
});

async function appendToGoogleSheetWeekly(competitorName, ads, runDate) {
  const sheetId = process.env.GOOGLE_SHEET_KEY || "1tP20p8VCdsYITxGirBqGwi10HNki_3HE64V3esZZuwo";
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    console.log("[Google Sheets] Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY. Skipping sheet export.");
    return;
  }

  try {
    const serviceAccountAuth = new JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
    await doc.loadInfo(); 

    // The sheet title is just the competitor name
    const sheetTitle = competitorName;

    // Determine headers dynamically based on new ads
    let maxImages = 1;
    let maxVideos = 1;
    for (const ad of ads) {
      if (ad.images && Array.isArray(ad.images)) {
        let count = ad.images.filter(img => img && img.original_image_url).length;
        if (count > maxImages) {
          maxImages = count;
        }
      }
      if (ad.videos && Array.isArray(ad.videos)) {
        let count = ad.videos.filter(v => v && (v.video_hd_url || v.video_preview_image_url)).length;
        if (count > maxVideos) {
          maxVideos = count;
        }
      }
    }

    const headers = ['Ngày truy vấn', 'Ngày bắt đầu', 'Ngày kết thúc', 'Nội dung gốc', 'Video'];
    for (let i = 2; i <= maxVideos; i++) {
      headers.push(`Video ${i}`);
    }

    headers.push('Ảnh');
    for (let i = 2; i <= maxImages; i++) {
      headers.push(`Ảnh ${i}`);
    }

    // Get or create current sheet
    let sheet = doc.sheetsByIndex.find(s => s.title.toLowerCase() === sheetTitle.toLowerCase());
    let isNewSheet = false;
    if (!sheet) {
      sheet = await doc.addSheet({ 
        title: sheetTitle, 
        headerValues: headers 
      });
      isNewSheet = true;
    } else {
      await sheet.setHeaderRow(headers);
    }

    const rows = [];
    for (const ad of ads) {
      const row = {
        // format yyyy-mm-dd hh:mm:ss VietNam +7
        'Ngày truy vấn': new Date(Date.now() + 7 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
        'Ngày bắt đầu': ad.start_date_string?.split('T')[0] || '',
        'Ngày kết thúc': ad.end_date_string?.split('T')[0] || '',
        'Nội dung gốc': ad.text || '',
      };

      if (ad.videos && Array.isArray(ad.videos)) {
        let videoIndex = 1;
        for (const v of ad.videos) {
          if (v && (v.video_hd_url || v.video_preview_image_url)) {
            const header = videoIndex === 1 ? 'Video' : `Video ${videoIndex}`;
            // Use semicolon (;) instead of comma (,) for Vietnamese Google Sheets locale
            row[header] = `=HYPERLINK("${v.video_hd_url || ''}"; IMAGE("${v.video_preview_image_url || ''}"))`;
            videoIndex++;
          }
        }
      }

      if (ad.images && Array.isArray(ad.images)) {
        let imgIndex = 1;
        for (const img of ad.images) {
          if (img && img.original_image_url) {
            const header = imgIndex === 1 ? 'Ảnh' : `Ảnh ${imgIndex}`;
            row[header] = `=IMAGE("${img.original_image_url}")`;
            imgIndex++;
          }
        }
      }

      rows.push(row);
    }

    if (rows.length > 0) {
      await sheet.addRows(rows);
      console.log(`[Google Sheets] Đã nối thêm ${rows.length} quảng cáo mới vào sheet "${sheetTitle}".`);
    } else {
      console.log(`[Google Sheets] Không có quảng cáo mới nào để nối vào sheet "${sheetTitle}".`);
    }

    // Cleanup old data (>= 3 weeks old based on Ngày bắt đầu)
    // 3 weeks = 21 days
    const cutoff3WeeksDate = new Date();
    cutoff3WeeksDate.setDate(cutoff3WeeksDate.getDate() - 21);
    cutoff3WeeksDate.setHours(0, 0, 0, 0);

    const existingRows = await sheet.getRows();
    let deletedCount = 0;
    
    // Iterate from bottom to top to safely delete without shifting indices
    for (let i = existingRows.length - 1; i >= 0; i--) {
      const row = existingRows[i];
      const startDateStr = row.get('Ngày bắt đầu');
      if (startDateStr) {
        const startDate = new Date(startDateStr);
        if (!isNaN(startDate.getTime()) && startDate < cutoff3WeeksDate) {
          await row.delete();
          deletedCount++;
        }
      }
    }

    if (deletedCount > 0) {
      console.log(`[Google Sheets] Đã xóa ${deletedCount} dòng dữ liệu cũ (>= 3 tuần) trong sheet "${sheetTitle}".`);
    }

  } catch (error) {
    console.error("[Google Sheets] Error saving to Google Sheet:", error.message);
  }
}

async function runWeeklyJob() {
  const competitorsArg = process.argv[2];
  const daysLimitArg = process.argv[3];
  const searchArg = process.argv[4];

  if (!competitorsArg) {
    console.error(JSON.stringify({
      type: "error",
      reason: "missing_parameters",
      message: "Missing competitors parameter. Please pass competitors as the first CLI argument."
    }, null, 2));
    process.exit(1);
  }

  const competitors = competitorsArg.split(',').map(c => c.trim()).filter(Boolean);

  if (!competitors.length) {
    console.error(JSON.stringify({
      type: "error",
      reason: "no_competitors",
      message: "No competitors defined. Please pass competitors as the first CLI argument."
    }, null, 2));
    process.exit(1);
  }

  const daysLimit = (Number(daysLimitArg) > 0) ? Number(daysLimitArg) : 7;

  // Calculate cutoff date (daysLimit days ago at 00:00:00 local time)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysLimit);
  cutoffDate.setHours(0, 0, 0, 0);

  // Get current date string in Vietnam timezone +7 YYYY-MM-DD
  const runDate = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];

  console.log(`[Weekly Job] Starting weekly job for ${competitors.length} competitors. Cutoff date: >= ${cutoffDate.toISOString().split('T')[0]}. Run date: ${runDate}`);

  const resultsSummary = [];

  for (const competitor of competitors) {
    console.log(`\n--------------------------------------------`);
    console.log(`[Weekly Job] Processing competitor: "${competitor}"`);
    try {
      // 1. Search company
      const pageInfo = await searchCompanyAndGetPageId(competitor);
      console.log(`[Weekly Job] Found competitor: "${pageInfo.name}" (ID: ${pageInfo.page_id})`);

      // 2. Get ads
      const rawAds = await getCompanyAds(pageInfo.page_id, 100);
      console.log(`[Weekly Job] Retrieved ${rawAds.length} total active ads.`);

      // 3. Filter by active time (overlapping with the cutoff period)
      let filteredAds = rawAds.filter(ad => {
        if (!ad.start_date_string) return false;
        
        const start = new Date(ad.start_date_string);
        const now = new Date();
        
        // Ignore ads scheduled in the future
        if (start > now) return false;
        
        // If ad has an end date, it must be on or after cutoffDate
        if (ad.end_date_string) {
          const end = new Date(ad.end_date_string);
          return end >= cutoffDate;
        }
        
        // No end date means it is currently active
        return true;
      });

      if (searchArg) {
        const searchLower = searchArg.toLowerCase();
        filteredAds = filteredAds.filter(ad => ad.text && ad.text.toLowerCase().includes(searchLower));
        console.log(`[Weekly Job] ${filteredAds.length} ads match the active time filter and search string "${searchArg}".`);
      } else {
        console.log(`[Weekly Job] ${filteredAds.length} ads match the active time filter (active within the last ${daysLimit} days).`);
      }

      // 4. Push to sheet
      await appendToGoogleSheetWeekly(competitor, filteredAds, runDate);

      resultsSummary.push({
        competitor,
        status: "success",
        total_found: rawAds.length,
        filtered_count: filteredAds.length
      });
    } catch (err) {
      console.error(`[Weekly Job] Error processing competitor "${competitor}":`, err.message);
      resultsSummary.push({
        competitor,
        status: "failed",
        error: err.message
      });
    }
  }

  console.log(`\n============================================`);
  console.log(`[Weekly Job] Job completed! Summary:`);
  console.log(JSON.stringify(resultsSummary, null, 2));
}

runWeeklyJob();
