import type { CSSProperties, ReactNode } from "react";

const P: Record<string, ReactNode> = {
  house: <path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  alert: <path d="M12 4 2.8 19.5h18.4L12 4Zm0 6v4.5m0 2.6v.1" />,
  power: <path d="M12 3v8M6.4 6.6a8 8 0 1 0 11.2 0" />,
  bulb: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z" />,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z" />,
  drive: <path d="M3 13.5 5.6 5.8A1.5 1.5 0 0 1 7 4.8h10a1.5 1.5 0 0 1 1.4 1L21 13.5v4A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Zm0 0h18M16.5 16.2h.1" />,
  terminal: <path d="M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4" />,
  globe: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.4 2.6 3.5 5.6 3.5 9s-1.1 6.4-3.5 9c-2.4-2.6-3.5-5.6-3.5-9S9.6 5.6 12 3Z" />,
  keyboard: <path d="M3 6.5h18v11H3zM6.5 10h.1M10 10h.1M13.5 10h.1M17 10h.1M7.5 14h9" />,
  play: <path d="M7 4.5v15l12.5-7.5Z" />,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  restart: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4.5H9" />,
  lock: <path d="M6 10.5h12V20H6zM8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />,
  camera: <path d="M3 8h3.5L8 5.5h8L17.5 8H21v11H3zM12 10.5a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z" />,
  bell: <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15ZM10 20.5h4" />,
  thermo: <path d="M10 13.5V5a2 2 0 0 1 4 0v8.5a4 4 0 1 1-4 0ZM12 10v6.5" />,
  sun: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />,
  cloud: <path d="M7 18.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 18.5Z" />,
  rain: <path d="M7 15h10.5a3.8 3.8 0 0 0 .4-7.6 6 6 0 0 0-11.6 1.4A3.1 3.1 0 0 0 7 15Zm1 3-1 2.5m5-2.5-1 2.5m5-2.5-1 2.5" />,
  snow: <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />,
  storm: <path d="M7 14h10.5a3.8 3.8 0 0 0 .4-7.6 6 6 0 0 0-11.6 1.4A3.1 3.1 0 0 0 7 14Zm6-1-2.5 4h3L11 21" />,
  fog: <path d="M4 9h16M3 13h18M5 17h14" />,
  fan: <path d="M12 12c0-4 1-8 4-8s3 4-4 8Zm0 0c4 0 8 1 8 4s-4 3-8-4Zm0 0c0 4-1 8-4 8s-3-4 4-8Zm0 0c-4 0-8-1-8-4s4-3 8 4Z" />,
  plug: <path d="M9 3v5m6-5v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0Zm5.5 8.5V21" />,
  sliders: <path d="M5 4v16M12 4v16M19 4v16M3 8h4m3 8h4m3-6h4" />,
  gear: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />,
  monitor: <path d="M3 4.5h18v12H3zM8.5 20h7M12 16.5V20" />,
  wifioff: <path d="M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.3m5.5-.1A10 10 0 0 1 19 12.5M2 9a14 14 0 0 1 4.5-2.7m4.2-.8A14 14 0 0 1 22 9M12 19.5h.1" />,
  send: <path d="M4 12 20 4l-5 16-3.5-6.5Zm7.5 1.5L20 4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  copy: <path d="M8 8h12v12H8zM4 16V4h12" />,
  trash: <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16Zm9-13 4 4" />,
  logo: <path d="M3.5 11 12 4l8.5 7v9h-17ZM8 14.5h8M8 17.5h5" />,
  image: <path d="M3.5 5h17v14h-17zM3.5 16l5-5 4 4 3-3 5 5M15.5 8.5h.1" />,
};

const ALIASES: Record<string, string> = {
  home: "house", ok: "check", close: "x", shutdown: "power", sleep: "moon", reboot: "restart", light: "bulb",
  lamp: "bulb", script: "terminal", url: "globe", keys: "keyboard", launch: "play", open: "folder", system: "power",
  steam: "play", game: "play", "monitor-off": "monitor", display: "monitor", door: "bell", doorbell: "bell", temp: "thermo",
  warning: "alert", settings: "gear", lockscreen: "lock",
};

export function hasIcon(name?: string) {
  if (!name) return false;
  return !!P[name] || !!P[ALIASES[name]];
}

export function Icon({ name, size = 24, style, stroke = 1.9 }: { name: string; size?: number; style?: CSSProperties; stroke?: number }) {
  const key = P[name] ? name : ALIASES[name];
  if (!key) {
    // emoji or unknown name: render the text itself if short (emoji), else nothing
    if (name && name.length <= 4) return <span style={{ fontSize: size * 0.9, lineHeight: 1, ...style }} aria-hidden>{name}</span>;
    return null;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden focusable="false">
      {P[key]}
    </svg>
  );
}
