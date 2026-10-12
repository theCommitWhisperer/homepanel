import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HAOS_IMAGES, HAOS_VERSION } from "./constants.js";
import type { HostType } from "./state.js";

/**
 * Short, printable guides. The long versions live in docs/ (open_guide returns those when the
 * installer runs from a repo checkout).
 */
export const HOST_TYPES: { value: HostType; name: string; description: string; doc: string }[] = [
  {
    value: "x86-bare-metal",
    name: "Intel/AMD mini PC, bare metal (ACEMAGICIAN T8 Plus, NUC, …)",
    description: "Wipe the PC and install Home Assistant OS. Best option for a dedicated box.",
    doc: "hardware/t8-plus-and-x86.md",
  },
  {
    value: "raspberry-pi",
    name: "Raspberry Pi 4 / 5",
    description: "Home Assistant OS on an SSD (recommended) or a good SD card.",
    doc: "hardware/raspberry-pi.md",
  },
  { value: "ha-green", name: "Home Assistant Green", description: "Already runs HA OS. Plug in and go.", doc: "hardware/ha-green.md" },
  {
    value: "linux-docker",
    name: "Linux box with Docker (this computer)",
    description: "HA Container + Mosquitto + HomePanel with Docker Compose. No apps/add-ons.",
    doc: "hardware/linux-docker.md",
  },
  {
    value: "nas-proxmox",
    name: "NAS or Proxmox (virtual machine)",
    description: "Home Assistant OS in a VM on Proxmox, Synology, Unraid, TrueNAS.",
    doc: "hardware/nas-proxmox.md",
  },
  {
    value: "vm-windows",
    name: "Only a Windows PC (VirtualBox VM)",
    description: "Home Assistant OS in VirtualBox. Works, but HA is off whenever the PC is.",
    doc: "hardware/vm-windows.md",
  },
];

export function hostDoc(t: HostType) {
  return HOST_TYPES.find((h) => h.value === t)!.doc;
}

/** Topics for open_guide → docs file. */
export const GUIDE_TOPICS: Record<string, string> = {
  quickstart: "quickstart.md",
  "t8-plus": "hardware/t8-plus-and-x86.md",
  x86: "hardware/t8-plus-and-x86.md",
  "raspberry-pi": "hardware/raspberry-pi.md",
  "ha-green": "hardware/ha-green.md",
  "vm-windows": "hardware/vm-windows.md",
  "linux-docker": "hardware/linux-docker.md",
  "nas-proxmox": "hardware/nas-proxmox.md",
  ipad: "screens/ipad.md",
  "fire-hd8": "screens/fire-hd8.md",
  android: "screens/android.md",
  "pi-screen": "screens/pi.md",
  "windows-screen": "screens/windows.md",
  doorbells: "doorbells.md",
  zigbee: "zigbee-zbt1.md",
  "remote-access": "remote-access.md",
  "ai-assistant": "ai-assistant.md",
  widgets: "widgets.md",
  "writing-a-widget": "writing-a-widget.md",
};

export function readGuide(repoRoot: string | undefined, topic: string, maxChars = 8000): string {
  const file = GUIDE_TOPICS[topic];
  if (!file) return `Unknown topic "${topic}". Topics: ${Object.keys(GUIDE_TOPICS).join(", ")}`;
  const p = repoRoot ? join(repoRoot, "docs", file) : undefined;
  if (p && existsSync(p)) {
    const t = readFileSync(p, "utf8");
    return t.length > maxChars ? t.slice(0, maxChars) + "\n…(truncated)" : t;
  }
  return `The full guide is docs/${file} in the HomePanel repository.`;
}

export const BIOS_STEPS = [
  "Plug in a keyboard and monitor. Power on and tap Del (or F7 for the boot menu) on the ACEMAGICIAN logo.",
  "Boot mode: UEFI only (disable CSM/Legacy if present).",
  "Secure Boot: Disabled (HA OS is not signed for Secure Boot).",
  "Chipset → 'Restore on AC Power Loss' (or 'State After G3'): Power On, so HA comes back after a power cut.",
  "Save and exit (F10).",
];

export function x86FlashScript(img = HAOS_IMAGES.genericX86): string {
  const file = img.split("/").pop()!;
  return `# Run in a terminal on the Ubuntu live USB (Try Ubuntu), connected to the internet.
wget ${img}
lsblk -d -o NAME,SIZE,MODEL,TRAN          # find the INTERNAL SSD (e.g. nvme0n1), NOT the usb stick
DISK=nvme0n1                              # <- change to the internal SSD name from the list
# safety check: refuse USB disks and the disk the live system booted from
[ "$(lsblk -dno TRAN /dev/$DISK)" = "usb" ] && echo "STOP: $DISK is a USB disk" && exit 1
lsblk -no MOUNTPOINT /dev/$DISK | grep -qE '^/(cdrom|run/live|isodevice)' && echo "STOP: live USB" && exit 1
read -p "Erase EVERYTHING on /dev/$DISK ($(lsblk -dno SIZE,MODEL /dev/$DISK))? Type YES: " OK && [ "$OK" = YES ] || exit 1
xzcat ${file} | sudo dd of=/dev/$DISK bs=4M status=progress conv=fsync
sync && echo "Done. Shut down, remove the USB stick, power on."`;
}

export const X86_GUIDE = (): string[] => [
  `Download Home Assistant OS ${HAOS_VERSION} for generic x86-64 (the image is written from a Ubuntu live USB, step 4).`,
  "Make a Ubuntu Desktop live USB with balenaEtcher or Rufus (8 GB+ stick).",
  "BIOS setup on the mini PC:\n     - " + BIOS_STEPS.join("\n     - "),
  "Boot the mini PC from the USB stick (F7 boot menu on ACEMAGICIAN) and choose 'Try Ubuntu'. This erases Windows 11 in the next step — back up anything you need first.",
  "Write HA OS to the internal SSD: either the 'Disks' app → select the internal SSD → ⋮ → Restore Disk Image → pick the .img.xz, or run the script printed below.",
  "Shut down, remove the USB stick, connect Ethernet (either port), power on. First boot takes 5–20 minutes.",
  "In your router, reserve (DHCP reservation) the mini PC's IP address so it never changes.",
  "Open http://homeassistant.local:8123 (or http://<ip>:8123). The installer continues from here.",
];

export const PI_GUIDE = (): string[] => [
  "Install Raspberry Pi Imager on your computer (raspberrypi.com/software).",
  "Choose device (Pi 4 or Pi 5) → Operating system → Other specific-purpose OS → Home assistants and home automation → Home Assistant → Home Assistant OS.",
  "Storage: a USB SSD (recommended) or a 32 GB+ A2 SD card. Write.",
  "Put the card/SSD in the Pi, connect Ethernet and the official power supply, power on. First boot takes ~5–20 minutes.",
  "Reserve the Pi's IP in your router, then open http://homeassistant.local:8123.",
];

export const GREEN_GUIDE = (): string[] => [
  "Connect the Home Assistant Green to your router with Ethernet, then plug in power.",
  "Wait until the LED is solid (about 5–10 minutes on first start).",
  "Reserve its IP in your router, then open http://homeassistant.local:8123.",
];

export const PROXMOX_GUIDE = (): string[] => [
  `Proxmox: create a VM (UEFI/OVMF, q35, 2 vCPU, 4 GB RAM, no CD), import the disk ${HAOS_IMAGES.qcow2} (unxz first) with \`qm importdisk <vmid> haos_ova-${HAOS_VERSION}.qcow2 local-lvm\`, attach it as the boot disk, disable Secure Boot in the VM's EFI settings. The community 'Home Assistant OS VM' helper script from community-scripts.github.io automates this — read it before running it.`,
  "Synology: Virtual Machine Manager → import the .ova (haos_ova-*.ova) image; 2 vCPU, 4 GB RAM, UEFI.",
  "Unraid/TrueNAS: create a VM with the qcow2 disk, UEFI, bridged network.",
  "USB sticks (ZBT-1): pass the USB device through to the VM.",
  "Reserve the VM's IP in your router, then open http://<vm-ip>:8123.",
];

export const VBOX_GUIDE = (): string[] => [
  "Install VirtualBox for Windows (virtualbox.org). The installer can download the HA OS disk and create the VM for you.",
  "Your PC must stay on for Home Assistant to work. Turn off sleep in Windows power settings.",
  "USB sticks (ZBT-1): VirtualBox needs the Extension Pack for USB 2/3 passthrough; add a USB filter for the stick in the VM settings.",
];

export const SCREEN_GUIDES: Record<string, { title: string; steps: (pairUrl: string) => string[] }> = {
  ipad: {
    title: "iPad",
    steps: (u) => [
      `Open Safari → ${u} → Share → Add to Home Screen. Open HomePanel from the home screen icon.`,
      "A 6-digit code appears. Approve it in the HomePanel admin page (Devices → Pending) and pick a profile (e.g. kitchen-ipad).",
      "Settings → Accessibility → Guided Access → On (set a passcode). Open HomePanel, triple-click the side/home button → Start.",
      "Settings → Display & Brightness → Auto-Lock → Never. Keep it plugged in.",
    ],
  },
  "fire-hd8": {
    title: "Fire HD 8 (10th gen)",
    steps: (u) => [
      "Remove lock-screen ads: pay the one-time fee in your Amazon account (Content & Devices → Devices → Remove ads), or use Amazon Fire Toolbox on a PC (unofficial).",
      "Install Fully Kiosk Browser: enable 'Apps from unknown sources' and install the APK from fully-kiosk.com (or via Fire Toolbox, which can also add Google Play).",
      `Fully Kiosk → Settings → Web Content → Start URL: ${u}`,
      "Fully → Device Management: Keep screen on; Screen brightness as you like. Kiosk Mode on (with PIN).",
      "Optional (Fully PLUS licence): Remote Administration on — HomePanel can then wake the screen when the doorbell rings (add it under fully_kiosk in the server config).",
      "Assign the 'fire-hd8' profile (lite: no animations, snapshots instead of video) when approving the pairing.",
    ],
  },
  android: {
    title: "Android tablet",
    steps: (u) => [
      `Install Fully Kiosk Browser from Google Play. Start URL: ${u}`,
      "Turn on Kiosk Mode and Keep Screen On. Approve the 6-digit code in HomePanel admin.",
    ],
  },
  pi: {
    title: "Raspberry Pi + screen",
    steps: (u) => [
      "Install Raspberry Pi OS (with desktop). Copy deploy/pi-kiosk/ to the Pi.",
      `Run: HOMEPANEL_URL=${u} bash deploy/pi-kiosk/install.sh  — it sets up Chromium in kiosk mode on boot.`,
      "Approve the 6-digit code in HomePanel admin.",
    ],
  },
  windows: {
    title: "Windows PC / monitor",
    steps: (u) => [
      `Quick: a desktop shortcut to: msedge.exe --kiosk ${u} --edge-kiosk-type=fullscreen --no-first-run`,
      "Locked-down: Windows Settings → Accounts → Other users → Set up a kiosk (Assigned Access) → Microsoft Edge → digital sign / fullscreen. See deploy/windows-kiosk.md.",
    ],
  },
};
