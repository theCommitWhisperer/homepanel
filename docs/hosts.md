# Hosts: where Home Assistant + HomePanel run

HomePanel runs next to Home Assistant. Pick your hardware, follow its section, then continue with
[getting-started.md](getting-started.md) from step 2 (or just run `homepanel setup`).

| Hardware | Install | Apps (add-ons) | Section |
| --- | --- | --- | --- |
| ACEMAGICIAN T8 Plus / any Intel-AMD mini PC | HA OS, bare metal | yes | [x86 mini PC](#x86-mini-pc) |
| Raspberry Pi 4 / 5 | HA OS | yes | [Raspberry Pi](#raspberry-pi) |
| Home Assistant Green | HA OS (preinstalled) | yes | [HA Green](#ha-green) |
| Linux server with Docker Engine 23+ | HA Container (compose) | no | [Linux + Docker](#linux-docker) |
| Proxmox / Synology / Unraid / TrueNAS | HA OS in a VM | yes | [NAS / Proxmox](#nas-proxmox) |
| Only a Windows PC | HA OS in VirtualBox | yes | [Windows + VirtualBox](#windows-virtualbox) |

> Docker Desktop (Windows/macOS/Linux) is **not** supported by Home Assistant. Use Docker Engine on Linux, or HA OS in a VM.


---

<a id="x86-mini-pc"></a>

## Home Assistant OS on an Intel/AMD mini PC (ACEMAGICIAN T8 Plus, NUC, Beelink, …)

This replaces Windows with **Home Assistant OS**: the full HA install with apps (add-ons), backups and updates.
An Intel N100 such as the T8 Plus is more than fast enough. HA OS uses a few percent of the CPU.

**What you need:** a USB stick (8 GB or more), another computer to prepare the stick, a keyboard and monitor for the
mini PC, and an Ethernet cable. Allow about 45 minutes.

> ⚠️ This **erases everything** on the mini PC, including Windows 11 and the Windows license that came with it.
> If you might want Windows again later, first make a recovery drive in Windows
> (*Create a recovery drive*) or a full image backup.

### 1. Prepare a Ubuntu live USB

1. Download **Ubuntu Desktop** (any recent LTS) from ubuntu.com.
2. Write it to the USB stick with **balenaEtcher** or **Rufus**.

We boot Ubuntu from the stick only so we can write the HA OS image to the mini PC's internal SSD.
Nothing gets installed.

### 2. BIOS settings

Connect the keyboard and monitor. Power on and tap **Del** on the ACEMAGICIAN logo. On other brands the key is
usually Del, F2 or Esc. Menu names vary between BIOS versions; look for these settings:

| Setting | Value | Why |
| --- | --- | --- |
| Boot mode / CSM | **UEFI only** (CSM disabled) | HA OS boots with UEFI |
| **Secure Boot** | **Disabled** | HA OS is not signed for Secure Boot |
| **Restore on AC Power Loss** (sometimes *State After G3* or *Power On after power failure*) | **Power On** | HA starts again by itself after a power cut |
| Wake on LAN | optional | |

Save and exit with **F10**.

### 3. Boot the live USB

Plug in the stick and restart. Tap **F7** to open the boot menu (on most other brands it's F11, F12 or Esc), then choose the USB stick.
Choose **Try Ubuntu**, not *Install*. Connect to the internet: Ethernet works without setup.

### 4. Write HA OS to the internal SSD

The image you need is `haos_generic-x86-64-18.3.img.xz` from the
[HA OS releases page](https://github.com/home-assistant/operating-system/releases). 18.3 was current when this was written.
A newer version is fine; HA updates itself after install anyway.

#### Option A: the Disks app (easiest)

1. Download the `.img.xz` in Firefox.
2. Open **Disks**. Select the **internal SSD** on the left. On the T8 Plus it's an NVMe drive of about 512 GB. **Don't** select the USB stick.
3. Click ⋮ → **Restore Disk Image…**, pick the `.img.xz`, and click **Start Restoring**.

#### Option B: terminal (includes a disk check)

`homepanel setup` prints this same script. Change `DISK` to the name of your internal SSD:

```bash
wget https://github.com/home-assistant/operating-system/releases/download/18.3/haos_generic-x86-64-18.3.img.xz
lsblk -d -o NAME,SIZE,MODEL,TRAN          # find the INTERNAL SSD (e.g. nvme0n1), NOT the usb stick
DISK=nvme0n1                              # <- change to the internal SSD name from the list
## safety check: refuse USB disks and the disk the live system booted from
[ "$(lsblk -dno TRAN /dev/$DISK)" = "usb" ] && echo "STOP: $DISK is a USB disk" && exit 1
lsblk -no MOUNTPOINT /dev/$DISK | grep -qE '^/(cdrom|run/live|isodevice)' && echo "STOP: live USB" && exit 1
read -p "Erase EVERYTHING on /dev/$DISK ($(lsblk -dno SIZE,MODEL /dev/$DISK))? Type YES: " OK && [ "$OK" = YES ] || exit 1
xzcat haos_generic-x86-64-18.3.img.xz | sudo dd of=/dev/$DISK bs=4M status=progress conv=fsync
sync && echo "Done. Shut down, remove the USB stick, power on."
```

### 5. First boot

1. Shut down and unplug the USB stick.
2. Connect Ethernet. The T8 Plus has two ports and either one works. Power on.
3. The monitor shows the HA console with its IP address. The first start downloads the latest Home Assistant and
   takes **5–20 minutes**.
4. In your router, set up a **DHCP reservation** (sometimes called a *static lease*) for the mini PC's MAC address, so the IP never changes.
   Screens and PC agents connect to this IP.

### 6. Continue

Open `http://homeassistant.local:8123`. If that doesn't work, use `http://<ip>:8123`. Then run `homepanel setup` or
continue with [getting-started step 2](getting-started.md#2-onboarding-5-min).

### Troubleshooting

- **The mini PC boots straight into Windows or "no boot device":** Secure Boot is still on, or the image went to the
  USB stick instead of the SSD. Check the BIOS boot order and look for "Home Assistant OS" or the NVMe drive.
- **The console shows no IP:** check the cable. HA OS has no Wi-Fi setup on the console, so use Ethernet.
- **`homeassistant.local` doesn't resolve:** some routers and Android devices don't support mDNS. Use the IP address.
- **Two network ports:** HA OS uses whichever port has a cable. If you plug in both, set the network in
  HA → Settings → System → Network.


---

<a id="raspberry-pi"></a>

## Home Assistant OS on a Raspberry Pi 4 or 5

A Pi 4 with 4 GB or more, or any Pi 5, runs Home Assistant and HomePanel well. Building the HomePanel app on a Pi is slow
the first time (expect 15+ minutes), but after that it runs fine.

**What you need:** a Pi 4 or 5 with its **official power supply**, Ethernet, and **one** of:
- a **USB SSD** (recommended: much more reliable than an SD card), or
- a good 32 GB+ **A2** SD card

### Steps

1. Install **Raspberry Pi Imager** (raspberrypi.com/software) on your computer.
2. **Choose device:** Raspberry Pi 4 or 5.
   **Choose OS:** *Other specific-purpose OS → Home assistants and home automation → Home Assistant → Home Assistant OS*.
   **Choose storage:** your SSD or SD card. Click **Write**.
3. Put the card or SSD in the Pi, connect Ethernet and power. The first start takes 5–20 minutes.
4. In your router, set a DHCP reservation for the Pi.
5. Open `http://homeassistant.local:8123` and continue with [getting-started step 2](getting-started.md#2-onboarding-5-min),
   or run `homepanel setup` from any computer on the network.

### Notes

- **Booting from a USB SSD:** a Pi 5 and current Pi 4 firmware boot from USB by default. If a Pi 4 doesn't, flash
  *Misc utility images → Bootloader → USB Boot* to an SD card once.
- **ZBT-1:** use a USB extension cable and keep the stick away from the Pi's USB 3 (blue) ports and the SSD.
- **Image file names:** `haos_rpi4-64-<version>.img.xz` / `haos_rpi5-64-<version>.img.xz` on the HA OS releases page, if you
  prefer balenaEtcher to Pi Imager.


---

<a id="ha-green"></a>

## Home Assistant Green

The Green ships with Home Assistant OS already installed, so you can skip the install step.

1. Connect it to your router with Ethernet, then plug in power.
2. Wait for the LEDs to settle. The first start takes about 5–10 minutes.
3. In your router, set a DHCP reservation for it.
4. Open `http://homeassistant.local:8123` (or `http://<ip>:8123`) and continue with
   [getting-started step 2](getting-started.md#2-onboarding-5-min), or run `homepanel setup`.

### Notes

- The Green is an ARM (aarch64) device. The HomePanel app supports it, but the first build takes a while (roughly 10–20 minutes).
- It has USB ports for the ZBT-1. Use an extension cable.
- It has no HDMI output, so you can't use it as a screen itself.


---

<a id="linux-docker"></a>

## Linux box with Docker: HA Container + Mosquitto + HomePanel

Use this if you already have a Linux server you want to keep (home server, old laptop, Ubuntu on a mini PC).
You get Home Assistant **Container**, which has **no apps (add-ons)**. Mosquitto and HomePanel run as normal containers
instead, from [`deploy/compose/compose.yaml`](../deploy/compose/compose.yaml).

### Requirements

- Linux (Debian, Ubuntu, Fedora, …) with **Docker Engine 23 or newer** and the **Compose plugin**.
- **Not Docker Desktop**, on any OS. HA needs host networking for discovery, plus USB access, and Docker Desktop runs containers
  inside a hidden VM where neither works.
- Run the installer **on that Linux box**.

### Automatic

```bash
git clone <homepanel repo> && cd homepanel
pnpm install && pnpm --filter @homepanel/ai build && pnpm --filter @homepanel/installer build
node apps/installer/dist/cli.js setup      # choose "Linux box with Docker"
```

The installer:
1. runs `docker version` and checks that it is Engine ≥ 23, not Desktop, and that compose is installed. If Docker is missing, it offers the
   official `get.docker.com` script and shows you the commands before running them.
2. asks for a folder (default `~/homepanel`) and writes `compose.yaml`, `mosquitto/mosquitto.conf`, a random MQTT
   password (hashed into `mosquitto/passwd`) and `.env` (mode 600).
3. runs `docker compose up -d homeassistant mosquitto`, onboards HA, creates a token, adds the MQTT integration, and
   then runs `docker compose up -d --build homepanel`.

### By hand

The steps are listed in the header of `deploy/compose/compose.yaml`. In short:

```bash
mkdir -p ~/homepanel/mosquitto && cd ~/homepanel
cp <repo>/deploy/compose/compose.yaml . && cp <repo>/deploy/compose/mosquitto/mosquitto.conf mosquitto/
echo "homepanel:$(openssl rand -hex 16)" | tee mosquitto/passwd     # note the password
docker run --rm -v "$PWD/mosquitto:/mosquitto/config" eclipse-mosquitto:2 mosquitto_passwd -U /mosquitto/config/passwd
cat > .env <<EOF
TZ=America/Denver
HOMEPANEL_SRC=/path/to/homepanel-repo
MQTT_PASS=<the password>
ADMIN_PASSWORD=<pick one>
HA_TOKEN=
EOF
docker compose up -d homeassistant mosquitto
## onboard HA at http://<box>:8123, create a long-lived token (Profile → Security), put it in .env
docker compose up -d --build homepanel
```

Finally, in HA add the **MQTT** integration with broker `127.0.0.1`, port `1883`, user `homepanel` and the password above.

### Notes

- HA's config lives in `./homeassistant`. Back it up, because HA Container has no built-in backup scheduling the way HA OS does.
- **ZBT-1:** the HA container is `privileged`, so USB works. A tighter alternative is the `devices:` example in compose.yaml,
  using the `/dev/serial/by-id/...` path.
- Update everything with `docker compose pull && docker compose up -d`. For HomePanel, `git pull` and add `--build`.


---

<a id="nas-proxmox"></a>

## Home Assistant OS in a VM on Proxmox or a NAS

Running **HA OS in a VM** gives you the full HA experience, apps included, on hardware you already run 24/7.
Give it **2 vCPU, 4 GB RAM, 32 GB disk**, **UEFI (OVMF)** firmware, and a **bridged** network.

<a id="proxmox-ve"></a>

### Proxmox VE

This is the plan for the **ACEMAGICIAN T8 Plus**: Proxmox VE on the mini PC, Home Assistant OS as a VM on it.
`HomePanel.exe` → *Set up Home Assistant / mini PC* → **Mini PC running Proxmox VE** prints these steps and then
continues with onboarding once HA answers.

**Fast way — the community helper script** (community-scripts.org, "Home Assistant OS VM"). It runs as root on the
Proxmox host, so read it first: <https://github.com/community-scripts/ProxmoxVE/blob/main/vm/haos-vm.sh>.

1. Open the Proxmox web UI (`https://<proxmox-ip>:8006`), click your node (e.g. `pve`) → **Shell**.
   The command below runs **there, on the Proxmox host** — not on your Windows PC.
2. Paste:
   ```bash
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/vm/haos-vm.sh)"
   ```
3. Answer **Yes** to *Use Default Settings?*. It downloads the current stable HA OS image and creates a VM with UEFI,
   2 vCPU, 4 GB RAM, a 32 GB disk on bridge `vmbr0`, the QEMU guest agent on, and *start at boot* on.
4. After 5–20 minutes, open `http://<vm-ip>:8123` (the VM's *Summary* shows its IP). Reserve that IP in your router.

**By hand** (same result, no script):

1. Download `haos_ova-<version>.qcow2.xz` from the
   [HA OS releases](https://github.com/home-assistant/operating-system/releases) and run `unxz` on it.
2. Create a VM: *OS: Do not use any media*, *System: Machine q35, BIOS OVMF (UEFI)*, add an EFI disk, and
   **untick "Pre-Enroll keys"** so Secure Boot stays off. Delete the default disk. 2 cores, 4096 MB, bridge `vmbr0`.
3. Import the disk: `qm importdisk <vmid> haos_ova-<version>.qcow2 local-lvm`. In *Hardware*, attach the unused disk
   (SCSI or SATA), then set it first in *Options → Boot Order*. *Options → Start at boot: Yes*.
4. Start the VM. After 5–20 minutes, open `http://<vm-ip>:8123`.

**ZBT-1 passthrough:** plug the stick into the mini PC with a USB extension cable. VM → *Hardware → Add → USB Device* →
*Use USB Vendor/Device ID* → pick **10c4:ea60** (Silicon Labs CP210x / Home Assistant Connect ZBT-1) → *Add*, then
reboot the VM. Shell equivalent: `qm set <vmid> -usb0 host=10c4:ea60`. Passing it by ID (not by port) survives moving
the stick to another port.

### Synology (DSM 7, Virtual Machine Manager)

1. Download `haos_ova-<version>.ova`.
2. Virtual Machine Manager → **Virtual Machine → Create → Import** → *Import from OVA files*. 2 vCPU, 4 GB, and select **UEFI**
   if asked.
3. USB passthrough of the ZBT-1 works on some models only. If it doesn't on yours, consider a network Zigbee coordinator instead.

### Unraid / TrueNAS SCALE

Create a VM with UEFI firmware, attach the `qcow2` as the boot disk (VirtIO or SATA), and use a bridged network. Add the ZBT-1 as a USB device.

### HomePanel

Once HA is running, everything is the same as on a mini PC: run `HomePanel.exe` (mode 3) from any computer on your network, or follow the
[getting-started](getting-started.md) appendix from step 2.

> Running **HA Container** in Docker on the NAS also works (see [linux-docker.md](#linux-docker)), but Synology's
> Container Manager is a Docker *Engine*, and HA's discovery needs `network_mode: host`. Some NAS UIs hide that option.


---

<a id="windows-virtualbox"></a>

## Only a Windows PC: Home Assistant OS in VirtualBox

This works, but **Home Assistant is off whenever the PC is off or asleep**. Lights still work from their own
apps, but HomePanel screens and automations stop. Use it to try things out, or until you buy a small dedicated box
(an N100 mini PC costs about the same as a few smart bulbs).

> Docker Desktop on Windows does **not** work for Home Assistant Container: it can't do host networking, USB or mDNS
> properly. Use VirtualBox (or Hyper-V) with HA OS instead.

### Automatic (recommended)

Run `homepanel setup` on the Windows PC and choose **Only a Windows PC (VirtualBox VM)**. It will:

1. check VirtualBox is installed (install it first from virtualbox.org)
2. ask before downloading `haos_ova-18.3.vdi.zip` (about 500 MB) to `%USERPROFILE%\HomeAssistantVM`
3. show and then run these commands:

```text
VBoxManage createvm --name HomeAssistant --ostype Linux_64 --register
VBoxManage modifyvm HomeAssistant --firmware efi --memory 4096 --cpus 2 --nic1 bridged --bridgeadapter1 "<your adapter>" --graphicscontroller vmsvga --usb-xhci on
VBoxManage storagectl HomeAssistant --name SATA --add sata --controller IntelAhci --portcount 1
VBoxManage storageattach HomeAssistant --storagectl SATA --port 0 --device 0 --type hdd --medium "%USERPROFILE%\HomeAssistantVM\haos_ova-18.3.vdi"
VBoxManage startvm HomeAssistant --type headless
```

`VBoxManage.exe` lives in `C:\Program Files\Oracle\VirtualBox\`.

### By hand

1. Download `haos_ova-<version>.vdi.zip` from the
   [HA OS releases](https://github.com/home-assistant/operating-system/releases) and unzip it.
2. VirtualBox → **New**: name *HomeAssistant*, type *Linux*, version *Other Linux (64-bit)*, 4096 MB memory, 2 CPUs,
   **Enable EFI** ticked, *Use an existing virtual hard disk file* → the `.vdi`.
3. Settings → **Network** → Adapter 1: **Bridged Adapter**, set to your wired network card (Wi-Fi bridging works on most PCs, but not all).
4. Start it. After 5–20 minutes, open `http://homeassistant.local:8123` or the IP shown in the VM console.

### Keep it running

- Windows Settings → System → Power → **Sleep: Never** while plugged in.
- Start the VM automatically: put a shortcut to
  `"C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" startvm HomeAssistant --type headless`
  in `shell:startup`. This only runs once you log in. VirtualBox's autostart service is an alternative, but it's harder to set up.
- Shut down HA from inside HA first (Settings → System → ⋮ → Shut down), or run `VBoxManage controlvm HomeAssistant acpipowerbutton`.

### USB (ZBT-1)

Install the **VirtualBox Extension Pack** (same version as VirtualBox) for USB 2/3. Then go to VM Settings → USB → USB 3.0 →
add a filter for the ZBT-1 (*Nabu Casa / Home Assistant Connect ZBT-1*). Windows then gives up the stick to the VM.

### Monitoring this PC

The HomePanel agent runs on Windows next to the VM, like on any other PC. It connects to the MQTT broker inside the VM at
`mqtt://<vm-ip>:1883`. Because the VM uses a bridged network, it has its own LAN IP, separate from the PC's.
