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
    doc: "hosts.md#x86-mini-pc",
  },
  {
    value: "proxmox",
    name: "Mini PC running Proxmox VE (ACEMAGICIAN T8 Plus → HA OS virtual machine)",
    description: "Keep Proxmox and run Home Assistant OS as a VM, created by the community helper script.",
    doc: "hosts.md#proxmox-ve",
  },
  {
    value: "raspberry-pi",
    name: "Raspberry Pi 4 / 5",
    description: "Home Assistant OS on an SSD (recommended) or a good SD card.",
    doc: "hosts.md#raspberry-pi",
  },
  { value: "ha-green", name: "Home Assistant Green", description: "Already runs HA OS. Plug in and go.", doc: "hosts.md#ha-green" },
  {
    value: "linux-docker",
    name: "Linux box with Docker (this computer)",
    description: "HA Container + Mosquitto + HomePanel with Docker Compose. No apps/add-ons.",
    doc: "hosts.md#linux-docker",
  },
  {
    value: "nas-proxmox",
    name: "NAS or Proxmox (virtual machine)",
    description: "Home Assistant OS in a VM on Proxmox, Synology, Unraid, TrueNAS.",
    doc: "hosts.md#nas-proxmox",
  },
  {
    value: "vm-windows",
    name: "Only a Windows PC (VirtualBox VM)",
    description: "Home Assistant OS in VirtualBox. Works, but HA is off whenever the PC is.",
    doc: "hosts.md#windows-virtualbox",
  },
];

export function hostDoc(t: HostType) {
  return HOST_TYPES.find((h) => h.value === t)!.doc;
}

/** Topics for open_guide → docs file. */
export const GUIDE_TOPICS: Record<string, string> = {
  "getting-started": "getting-started.md",
  hosts: "hosts.md",
  screens: "screens.md",
  "pc-agent": "pc-agent.md",
  doorbells: "doorbells.md",
  zigbee: "zigbee-zbt1.md",
  "remote-access": "remote-access.md",
  "ai-assistant": "ai-assistant.md",
  widgets: "widgets.md",
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

/** Command of the community "Home Assistant OS VM" helper (community-scripts.org/scripts/haos-vm). Checked October 2026. */
export const PROXMOX_HAOS_SCRIPT_URL = "https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/vm/haos-vm.sh";
export const PROXMOX_HAOS_COMMAND = `bash -c "$(curl -fsSL ${PROXMOX_HAOS_SCRIPT_URL})"`;
/** Home Assistant Connect ZBT-1 (Silicon Labs CP2102N) USB vendor:product id */
export const ZBT1_USB_ID = "10c4:ea60";

export const PROXMOX_HAOS_GUIDE = (): string[] => [
  "On any computer, open the Proxmox web UI: https://<proxmox-ip>:8006 (accept the certificate warning) and log in as root.",
  "Click your node (left, e.g. 'pve') → Shell. The next command runs THERE, on the Proxmox host — not on this PC.",
  `Paste this and press Enter (it is the community-scripts.org "Home Assistant OS VM" helper; read it first at ${PROXMOX_HAOS_SCRIPT_URL} if you like):`,
  "Answer 'Yes' to 'Use Default Settings?' → it downloads the latest stable HA OS image and creates a VM 'haos…' with UEFI, 2 vCPU, 4 GB RAM, a 32 GB disk on bridge vmbr0, starting at boot. The N100 handles this easily.",
  `ZBT-1 Zigbee stick: plug it into the mini PC with a USB extension cable (0.5–1 m, USB 2 port if there is one). Proxmox → the HA VM → Hardware → Add → USB Device → 'Use USB Vendor/Device ID' → pick the one with ${ZBT1_USB_ID} (Silicon Labs CP210x / Home Assistant Connect ZBT-1) → Add. Same thing in the Proxmox shell: qm set <vmid> -usb0 host=${ZBT1_USB_ID}`,
  "Restart the VM (VM → Reboot) so it sees the stick. Using the vendor/device id (not the port) keeps working if you move the stick to another port.",
  "Find the VM's address: VM → Summary → IPs (HA OS ships the guest agent), or the VM console shows it after boot. In your router, reserve that IP for the VM's MAC (VM → Hardware → Network Device).",
  "First boot takes 5–20 minutes. Then open http://<vm-ip>:8123 — this installer continues from there (onboarding, MQTT, token, ZBT-1).",
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
      `Open Safari → ${u} → Share → Add to Home Screen. Open HomePanel from the home screen icon (fullscreen, no Safari bars).`,
      "A 6-digit code appears. Approve it in the HomePanel admin page (Devices → Pending) and pick a profile (e.g. kitchen-ipad).",
      "Settings → Accessibility → Guided Access → On (set a passcode). Open HomePanel, triple-click the side/home button → Start.",
      "Settings → Display & Brightness → Auto-Lock → Never. Keep it plugged in.",
    ],
  },
  "fire-hd8": {
    title: "Fire HD 8 (10th gen)",
    steps: (u) => [
      "Remove lock-screen ads ('Special Offers'): either pay the one-time fee (amazon.com → Account → Content & Devices → Devices → your Fire → Remove ads), or use the unofficial Fire Toolbox on a Windows PC over ADB (enable Developer options by tapping Settings → Device Options → About Fire Tablet → Serial Number 7×, then USB debugging).",
      "Sideload Fully Kiosk Browser: Settings → Security & Privacy → Apps from Unknown Sources → Silk (or Files) → allow, then download the APK from fully-kiosk.com and install it (Fire Toolbox can also install it over ADB).",
      `Fully Kiosk → Settings → Web Content Settings → Start URL: ${u}  — a 6-digit code appears; approve it in the admin page with the 'fire-hd8' profile (lite). After pairing you may set the Start URL to ${u}/?token=<device token> so a reset app re-pairs itself.`,
      "Fully → Device Management: Keep Screen On; Screensaver/dim as you like. Kiosk Mode: on (set a PIN) so the Fire home screen can't be reached.",
      "Fully → Remote Administration (PLUS licence): on, set a password. Add it under fully_kiosk in the server config so HomePanel can wake the screen when the doorbell rings.",
      "Fire OS: Settings → Display → Sleep → never isn't offered; Fully's Keep Screen On handles it. Keep it on the charger.",
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
      `Run: HOMEPANEL_URL=${u} bash deploy/pi-kiosk/install.sh  — it starts \`chromium --kiosk ${u}\` on boot (no cursor, no screen blanking).`,
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
