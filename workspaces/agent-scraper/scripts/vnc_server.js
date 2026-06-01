const http = require('http');

function startVncServer(page, port) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>OpenClaw - Facebook Login</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #121212; color: #fff; margin: 0; display: flex; flex-direction: column; align-items: center; }
    header { width: 100%; background: #1e1e1e; padding: 15px 20px; box-sizing: border-box; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; }
    h1 { margin: 0; font-size: 1.2rem; color: #4CAF50; }
    .controls { display: flex; gap: 10px; margin-top: 15px; background: #1e1e1e; padding: 15px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
    input[type="text"] { padding: 10px; border: 1px solid #444; border-radius: 4px; background: #2c2c2c; color: white; outline: none; width: 250px; }
    button { padding: 10px 15px; border: none; border-radius: 4px; background: #0084ff; color: white; cursor: pointer; font-weight: bold; transition: background 0.2s; }
    button:hover { background: #0073e6; }
    .btn-secondary { background: #444; }
    .btn-secondary:hover { background: #555; }
    #screen-container { position: relative; margin-top: 20px; border: 2px solid #333; border-radius: 8px; overflow: hidden; background: #000; min-width: 800px; min-height: 600px; }
    #screen { display: block; max-width: 100%; height: auto; cursor: crosshair; }
    #status { padding: 5px 10px; border-radius: 4px; background: #ff9800; color: #000; font-weight: bold; font-size: 0.9rem; }
  </style>
</head>
<body>
  <header>
    <h1>OpenClaw Remote Browser</h1>
    <div id="status">Trình duyệt đang chạy... Hãy đăng nhập.</div>
  </header>

  <div class="controls">
    <input id="textInput" type="text" placeholder="Nhập text (user/pass/code)..." onkeydown="if(event.key === 'Enter') sendText()">
    <button onclick="sendText()">Gửi Text</button>
    <button class="btn-secondary" onclick="sendKey('Enter')">↵ Enter</button>
    <button class="btn-secondary" onclick="sendKey('Tab')">⇥ Tab</button>
    <button class="btn-secondary" onclick="sendKey('Backspace')">⌫ Backspace</button>
  </div>

  <div style="margin-top: 10px; color: #aaa; font-size: 0.9rem;">
    💡 Gợi ý: Bạn có thể click chuột, cuộn chuột (scroll), kéo thả (drag), và <b>GÕ PHÍM TRỰC TIẾP</b> trên màn hình bên dưới!
  </div>

  <div id="screen-container">
    <img id="screen" src="/screenshot?init" alt="Browser Screen" draggable="false" tabindex="0" />
  </div>

  <script>
    const img = document.getElementById('screen');
    const statusEl = document.getElementById('status');
    let isPolling = true;

    async function updateScreen() {
      if (!isPolling) return;
      try {
        const res = await fetch('/status');
        const data = await res.json();
        if (data.sessionValid) {
          statusEl.textContent = '✅ Đã lưu Session thành công! Bạn có thể đóng trang này.';
          statusEl.style.background = '#4CAF50';
          statusEl.style.color = '#fff';
          isPolling = false;
          return;
        }
        img.src = '/screenshot?' + Date.now();
      } catch (e) {
        statusEl.textContent = '❌ Đã đóng trình duyệt (Hoặc mất kết nối).';
        statusEl.style.background = '#f44336';
        statusEl.style.color = '#fff';
      }
      if (isPolling) setTimeout(updateScreen, 1000);
    }
    
    updateScreen();

    function getCoords(e) {
      const rect = img.getBoundingClientRect();
      const scaleX = 1280 / rect.width;
      const scaleY = 720 / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    }

    let isDragging = false;
    
    img.addEventListener('mousedown', async (e) => {
      if (!isPolling) return;
      isDragging = true;
      e.preventDefault(); // Ngăn kéo ảnh mặc định của trình duyệt
      const { x, y } = getCoords(e);
      await fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'mousedown', x, y })
      });
    });

    img.addEventListener('mousemove', async (e) => {
      if (!isPolling || !isDragging) return;
      const { x, y } = getCoords(e);
      fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'mousemove', x, y })
      });
    });

    img.addEventListener('mouseup', async (e) => {
      if (!isPolling) return;
      isDragging = false;
      const { x, y } = getCoords(e);
      await fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'mouseup', x, y })
      });
      img.src = '/screenshot?' + Date.now();
    });

    img.addEventListener('wheel', async (e) => {
      if (!isPolling) return;
      e.preventDefault();
      await fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY })
      });
      setTimeout(() => img.src = '/screenshot?' + Date.now(), 200);
    }, { passive: false });

    async function sendText() {
      if (!isPolling) return;
      const input = document.getElementById('textInput');
      if (!input.value) return;
      await fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'text', text: input.value })
      });
      input.value = '';
      img.src = '/screenshot?' + Date.now();
    }

    async function sendKey(key) {
      if (!isPolling) return;
      await fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'key', key })
      });
      img.src = '/screenshot?' + Date.now();
    }

    // Lắng nghe toàn bộ bàn phím để gõ trực tiếp
    document.addEventListener('keydown', async (e) => {
      if (!isPolling) return;
      // Bỏ qua nếu đang gõ vào ô input thủ công
      if (e.target.tagName === 'INPUT') return;
      
      e.preventDefault();
      
      // Playwright nhận diện đúng các phím như 'Enter', 'Backspace', 'a', 'A', v.v.
      // Một số phím cần map lại cho Playwright
      let key = e.key;
      if (key === ' ') key = 'Space';
      if (key === 'Control') key = 'Control';
      if (key === 'Alt') key = 'Alt';
      if (key === 'Shift') key = 'Shift';

      // Chống spam phím
      fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'key', key })
      });
      // Delay update screen cho cảm giác mượt hơn khi gõ nhanh
      setTimeout(() => img.src = '/screenshot?' + Date.now(), 100);
    });
  </script>
</body>
</html>
      `);
    } else if (req.method === 'GET' && req.url.startsWith('/screenshot')) {
      try {
        if (page.isClosed()) throw new Error('Closed');
        const buffer = await page.screenshot({ type: 'jpeg', quality: 50 });
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(buffer);
      } catch (e) {
        console.error('[VNC Server] Screenshot error:', e.message || e);
        res.writeHead(500); res.end();
      }
    } else if (req.method === 'GET' && req.url === '/status') {
      try {
        if (page.isClosed()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionValid: true }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionValid: false }));
      } catch (e) {
        res.writeHead(500); res.end();
      }
    } else if (req.method === 'POST' && req.url === '/action') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          if (page.isClosed()) throw new Error('Closed');
          const data = JSON.parse(body);
          if (data.type === 'mousedown') {
            await page.mouse.move(data.x, data.y);
            await page.mouse.down();
          } else if (data.type === 'mousemove') {
            await page.mouse.move(data.x, data.y);
          } else if (data.type === 'mouseup') {
            await page.mouse.move(data.x, data.y);
            await page.mouse.up();
          } else if (data.type === 'wheel') {
            await page.mouse.wheel(data.deltaX, data.deltaY);
          } else if (data.type === 'text') {
            await page.keyboard.type(data.text, { delay: 50 });
          } else if (data.type === 'key') {
            await page.keyboard.press(data.key);
          }
          res.writeHead(200); res.end();
        } catch (e) {
          console.error('[VNC Server] Action error:', e.message || e);
          res.writeHead(500); res.end();
        }
      });
    } else {
      res.writeHead(404); res.end();
    }
  });

  server.listen(port, '0.0.0.0');
  return server;
}

module.exports = { startVncServer };
