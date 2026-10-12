const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A fake doorbell camera frame with the current time burnt in. */
export function demoCameraSvg(name: string, now = new Date()): string {
  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  const date = now.toISOString().slice(0, 10);
  const sec = now.getSeconds();
  // a "visitor" that sways a little each second so the stream visibly updates
  const dx = Math.round(Math.sin(sec / 3) * 18);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2b3a"/><stop offset="1" stop-color="#3b4f63"/></linearGradient>
    <radialGradient id="lens" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.65"/></radialGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#sky)"/>
  <rect y="520" width="1280" height="200" fill="#4a4136"/>
  <rect x="0" y="560" width="1280" height="16" fill="#5d5245"/>
  <rect x="980" y="140" width="220" height="420" fill="#6b3a2a" stroke="#2a1a12" stroke-width="10"/>
  <circle cx="1170" cy="360" r="10" fill="#d8b75a"/>
  <rect x="80" y="380" width="160" height="140" rx="70" fill="#2f5d34"/>
  <g transform="translate(${560 + dx} 0)">
    <ellipse cx="80" cy="640" rx="110" ry="18" fill="#000" opacity="0.3"/>
    <rect x="10" y="300" width="140" height="300" rx="60" fill="#c76b3c"/>
    <circle cx="80" cy="230" r="72" fill="#e6b896"/>
    <path d="M10 220 Q80 120 150 220 Q150 170 80 150 Q10 170 10 220Z" fill="#3a2a20"/>
    <rect x="-40" y="380" width="80" height="60" rx="8" fill="#a07a50" stroke="#6e5234" stroke-width="4"/>
  </g>
  <rect width="1280" height="720" fill="url(#lens)"/>
  <rect x="24" y="24" width="470" height="56" rx="8" fill="#000" opacity="0.55"/>
  <text x="44" y="62" font-family="Menlo, Consolas, monospace" font-size="30" fill="#fff">${esc(name)} · DEMO</text>
  <rect x="${1280 - 24 - 400}" y="${720 - 24 - 56}" width="400" height="56" rx="8" fill="#000" opacity="0.55"/>
  <text x="${1280 - 44}" y="${720 - 40}" text-anchor="end" font-family="Menlo, Consolas, monospace" font-size="30" fill="#fff">${date} ${time}</text>
  <circle cx="1236" cy="52" r="10" fill="#e33"/>
</svg>`;
}
