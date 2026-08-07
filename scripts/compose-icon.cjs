// Compose the VS Code Marketplace icon from the official Jupyter + MCP logos,
// rendered to a 128x128 PNG via sharp.
//
// Design: Jupyter's orange notebook mark centered (the recognizable "what"),
// with the MCP protocol mark as a small badge in the bottom-right corner
// (the "how"). Clean white background for Marketplace legibility.
'use strict';
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const W = 128, H = 128;

// Official Jupyter notebook mark (paths from jupyter/notebook docs logo), scaled.
// Official MCP mark (paths from Wikimedia / modelcontextprotocol logo).
const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <!-- background: subtle light gradient -->
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f3f5f8"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- Jupyter notebook mark (orange), centered -->
  <g transform="translate(38 26) scale(1.32)">
    <path fill="#F37726" d="M 18.2646 7.13411C 10.4145 7.13411 3.55872 4.2576 0 0C 1.32539 3.8204 3.79556 7.13081 7.0686 9.47303C 10.3417 11.8152 14.2557 13.0734 18.269 13.0734C 22.2823 13.0734 26.1963 11.8152 29.4694 9.47303C 32.7424 7.13081 35.2126 3.8204 36.538 0C 32.9705 4.2576 26.1148 7.13411 18.2646 7.13411Z"/>
    <path fill="#F37726" d="M 18.2733 5.93931C 26.1235 5.93931 32.9793 8.81583 36.538 13.0734C 35.2126 9.25303 32.7424 5.94262 29.4694 3.6004C 26.1963 1.25818 22.2823 0 18.269 0C 14.2557 0 10.3417 1.25818 7.0686 3.6004C 3.79556 5.94262 1.32539 9.25303 0 13.0734C 3.56745 8.82463 10.4232 5.93931 18.2733 5.93931Z"/>
  </g>

  <!-- MCP mark badge (black protocol mark) bottom-right -->
  <g transform="translate(84 84) scale(0.20)">
    <path d="M18 84.8528L85.8822 16.9706C95.2548 7.59798 110.451 7.59798 119.823 16.9706V16.9706C129.196 26.3431 129.196 41.5391 119.823 50.9117L68.5581 102.177" stroke="#1a1a1a" stroke-width="12" stroke-linecap="round" fill="none"/>
    <path d="M69.2652 101.47L119.823 50.9117C129.196 41.5391 144.392 41.5391 153.765 50.9117L154.118 51.2652C163.491 60.6378 163.491 75.8338 154.118 85.2063L92.7248 146.6C89.6006 149.724 89.6006 154.789 92.7248 157.913L105.331 170.52" stroke="#1a1a1a" stroke-width="12" stroke-linecap="round" fill="none"/>
    <path d="M102.853 33.9411L52.6482 84.1457C43.2756 93.5183 43.2756 108.714 52.6482 118.087V118.087C62.0208 127.459 77.2167 127.459 86.5893 118.087L136.794 67.8822" stroke="#1a1a1a" stroke-width="12" stroke-linecap="round" fill="none"/>
  </g>
</svg>`;

async function main() {
    const out = path.join(process.cwd(), 'icon.png');
    await sharp(Buffer.from(svg))
        .resize(W, H)
        .png()
        .toFile(out);
    const meta = await sharp(out).metadata();
    console.log('wrote', out, meta.width + 'x' + meta.height, fs.statSync(out).size, 'bytes');
}

main().catch((e) => { console.error(e); process.exit(1); });
