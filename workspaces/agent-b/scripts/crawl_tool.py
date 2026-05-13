import sys
import json
import asyncio
import os
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing URL argument"}))
        sys.exit(1)
        
    target_url = sys.argv[1]
    
    # Định tuyến file đầu ra chuẩn về workspace của agent-b
    workspace_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_file = os.path.join(workspace_dir, "crawler_result.json")

    browser_cfg = BrowserConfig(headless=True, verbose=False)
    run_cfg = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        word_count_threshold=10,
        exclude_external_links=True
    )

    try:
        async with AsyncWebCrawler(config=browser_cfg) as crawler:
            result = await crawler.arun(url=target_url, config=run_cfg)

            data = {}
            if result.success:
                data = {
                    "status": "success",
                    "url": result.url,
                    "markdown": result.markdown,
                    "media": result.media,
                }
            else:
                data = {"status": "error", "error": result.error_message}

            # Ghi kết quả ra file JSON trong workspace
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dumps(data, f, ensure_ascii=False, indent=2)
                
            # Print ra stdout đường dẫn file để Agent biết đã lưu ở đâu
            print(f"Thành công: Dữ liệu đã được lưu tại {output_file}")
            
    except Exception as e:
        print(f"Lỗi hệ thống: {str(e)}")

if __name__ == "__main__":
    asyncio.run(main())
