/**
 * Key presses for `type: keys` actions.
 *
 *   keys: media_play_pause            one named key
 *   keys: ctrl+shift+m                a combo: modifiers held, last key tapped
 *   keys: win+alt+k / alt+f4 / f13    any VK name below, letters, digits, F1–F24
 *
 * Windows sends them with user32 keybd_event (via an Add-Type C# P/Invoke in PowerShell);
 * media/volume keys reach the media session whatever window has focus.
 */

/** Windows virtual-key codes (https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes) */
export const NAMED_VK: Record<string, number> = {
  media_play_pause: 0xb3,
  media_next: 0xb0,
  media_prev: 0xb1,
  media_stop: 0xb2,
  volume_up: 0xaf,
  volume_down: 0xae,
  volume_mute: 0xad,
  ctrl: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5b,
  enter: 0x0d,
  esc: 0x1b,
  tab: 0x09,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  printscreen: 0x2c,
  pause: 0x13,
  capslock: 0x14,
  numlock: 0x90,
  scrolllock: 0x91,
};

const ALIASES: Record<string, string> = {
  control: "ctrl",
  cmd: "win",
  super: "win",
  meta: "win",
  windows: "win",
  return: "enter",
  escape: "esc",
  del: "delete",
  pgup: "pageup",
  pgdn: "pagedown",
  play_pause: "media_play_pause",
  playpause: "media_play_pause",
  next: "media_next",
  prev: "media_prev",
  previous: "media_prev",
  media_previous: "media_prev",
  mute: "volume_mute",
};

const MODIFIERS = new Set(["ctrl", "shift", "alt", "win"]);

/** Keys that behave as "extended" keys (need KEYEVENTF_EXTENDEDKEY to be recognised correctly). */
const EXTENDED = new Set([
  0xb3, 0xb0, 0xb1, 0xb2, 0xaf, 0xae, 0xad, 0x5b, 0x2e, 0x2d, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x2c, 0x90,
]);

export function vkFor(name: string): number | undefined {
  const k = ALIASES[name] ?? name;
  if (k in NAMED_VK) return NAMED_VK[k];
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  const f = k.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (f) return 0x70 + Number(f[1]) - 1;
  return undefined;
}

export interface KeyStroke {
  /** VK codes in press order (modifiers first); released in reverse */
  vks: number[];
  /** normalised names, e.g. ["ctrl","shift","m"] */
  names: string[];
}

export function parseKeyCombo(input: string): KeyStroke {
  const parts = input
    .toLowerCase()
    .split("+")
    .map((p) => p.trim().replace(/[\s-]+/g, "_"));
  const names: string[] = [];
  const vks: number[] = [];
  for (const p of parts) {
    if (!p) throw new Error(`empty key in "${input}"`);
    const vk = vkFor(p);
    if (vk === undefined) throw new Error(`unknown key "${p}"`);
    names.push(ALIASES[p] ?? p);
    vks.push(vk);
  }
  if (names.length > 5) throw new Error("at most 5 keys in a combo");
  const mods = names.slice(0, -1);
  const bad = mods.find((m) => !MODIFIERS.has(m));
  if (bad) throw new Error(`"${bad}" is not a modifier; combos look like ctrl+shift+m (modifiers first)`);
  return { vks, names };
}

export function keyComboError(input: string): string | undefined {
  try {
    parseKeyCombo(input);
    return undefined;
  } catch (e) {
    return `${(e as Error).message}. Use a media key (media_play_pause, media_next, media_prev, volume_up, volume_down, volume_mute) or a combo like ctrl+shift+m`;
  }
}

/** PowerShell (5.1-compatible) that presses the combo with keybd_event. Only numeric VKs are interpolated. */
export function keyPressScript(stroke: KeyStroke): string {
  const ev = (vk: number, up: boolean) =>
    `[HomePanel.Keys]::keybd_event(${vk}, 0, ${(EXTENDED.has(vk) ? 1 : 0) | (up ? 2 : 0)}, [UIntPtr]::Zero)`;
  const down = stroke.vks.map((vk) => ev(vk, false));
  const up = [...stroke.vks].reverse().map((vk) => ev(vk, true));
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace HomePanel -Name Keys -MemberDefinition @'",
    '[DllImport("user32.dll")]',
    "public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);",
    "'@",
    "# flags: 1 = KEYEVENTF_EXTENDEDKEY, 2 = KEYEVENTF_KEYUP",
    ...down,
    "Start-Sleep -Milliseconds 30",
    ...up,
  ].join("\n");
}

/** Linux equivalents: xdotool key names. */
const XDO: Record<string, string> = {
  media_play_pause: "XF86AudioPlay",
  media_next: "XF86AudioNext",
  media_prev: "XF86AudioPrev",
  media_stop: "XF86AudioStop",
  volume_up: "XF86AudioRaiseVolume",
  volume_down: "XF86AudioLowerVolume",
  volume_mute: "XF86AudioMute",
  win: "super",
  esc: "Escape",
  enter: "Return",
  pageup: "Prior",
  pagedown: "Next",
  printscreen: "Print",
};
export function xdotoolCombo(stroke: KeyStroke): string {
  return stroke.names.map((n) => XDO[n] ?? n).join("+");
}
