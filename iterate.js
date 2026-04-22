import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simple HTTP server to serve HTML and static files
function startServer(port = 8080) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let filePath;
            let contentType = 'text/html';

            if (req.url === '/' || req.url === '') {
                filePath = path.join(__dirname, 'index.html');
            } else if (req.url === '/compare') {
                filePath = path.join(__dirname, 'compare.html');
            } else if (req.url === '/reference.png') {
                filePath = path.join(__dirname, 'reference.png');
                contentType = 'image/png';
            } else {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            try {
                const content = fs.readFileSync(filePath);
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            } catch (err) {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        server.listen(port, () => {
            console.log(`Server running at http://localhost:${port}`);
            resolve(server);
        });
    });
}

async function captureButton(page, filename) {
    await page.setViewport({ width: 600, height: 600 });
    await page.screenshot({
        path: filename,
        omitBackground: false
    });
    console.log(`✓ Screenshot saved: ${filename}`);
}

async function main() {
    let server;
    try {
        // Start server
        server = await startServer(8080);

        // Launch Puppeteer
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox']
        });

        // Capture comparison
        const comparePage = await browser.newPage();
        await comparePage.goto('http://localhost:8080/compare', { waitUntil: 'networkidle2' });
        await comparePage.setViewport({ width: 1000, height: 500 });
        await comparePage.screenshot({
            path: 'screenshots/comparison.png',
            omitBackground: false
        });
        console.log('✓ Screenshot saved: screenshots/comparison.png');

        // Single button page
        const page = await browser.newPage();
        await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });

        // Capture default state
        await captureButton(page, 'screenshots/button-default.png');

        // Simulate hover
        await page.evaluate(() => {
            document.querySelector('.glass-button').classList.add('hover-state');
        });
        await page.addStyleTag({
            content: '.glass-button.hover-state:hover { --force-hover: true; } .glass-button:hover { background: rgba(245, 240, 255, 0.28); border-color: rgba(255, 255, 255, 0.4); }'
        });
        await page.evaluate(() => {
            const btn = document.querySelector('.glass-button');
            btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        });
        await captureButton(page, 'screenshots/button-hover.png');

        // Simulate active state
        await page.evaluate(() => {
            const btn = document.querySelector('.glass-button');
            btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        await captureButton(page, 'screenshots/button-active.png');

        await browser.close();
        console.log('\n✓ Puppeteer verification complete!');
        console.log('Screenshots saved to /screenshots folder');

    } catch (error) {
        console.error('Error:', error);
    } finally {
        if (server) {
            server.close();
        }
        process.exit(0);
    }
}

main();
