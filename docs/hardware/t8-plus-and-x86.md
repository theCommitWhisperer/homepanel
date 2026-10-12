# Home Assistant OS on an Intel/AMD mini PC (ACEMAGICIAN T8 Plus, NUC, Beelink, …)

This replaces Windows with **Home Assistant OS**: the full HA install with apps (add-ons), backups and updates.
An Intel N100 such as the T8 Plus is more than fast enough. HA OS uses a few percent of the CPU.

**What you need:** a USB stick (8 GB or more), another computer to prepare the stick, a keyboard and monitor for the
mini PC, and an Ethernet cable. Allow about 45 minutes.

> ⚠️ This **erases everything** on the mini PC, including Windows 11 and the Windows license that came with it.
> If you might want Windows again later, first make a recovery drive in Windows
> (*Create a recovery drive*) or a full image backup.

## 1. Prepare a Ubuntu live USB

1. Download **Ubuntu Desktop** (any recent LTS) from ubuntu.com.
2. Write it to the USB stick with **balenaEtcher** or **Rufus**.

We boot Ubuntu from the stick only so we can write the HA OS image to the mini PC's internal SSD.
Nothing gets installed.

## 2. BIOS settings

Connect the keyboard and monitor. Power on and tap **Del** on the ACEMAGICIAN logo. On other brands the key is
usually Del, F2 or Esc. Menu names vary between BIOS versions; look for these settings:

| Setting | Value | Why |
| --- | --- | --- |
| Boot mode / CSM | **UEFI only** (CSM disabled) | HA OS boots with UEFI |
| **Secure Boot** | **Disabled** | HA OS is not signed for Secure Boot |
| **Restore on AC Power Loss** (sometimes *State After G3* or *Power On after power failure*) | **Power On** | HA starts again by itself after a power cut |
| Wake on LAN | optional | |

Save and exit with **F10**.

## 3. Boot the live USB

Plug in the stick and restart. Tap **F7** to open the boot menu (on most other brands it's F11, F12 or Esc), then choose the USB stick.
Choose **Try Ubuntu**, not *Install*. Connect to the internet: Ethernet works without setup.

## 4. Write HA OS to the internal SSD

The image you need is `haos_generic-x86-64-18.3.img.xz` from the
[HA OS releases page](https://github.com/home-assistant/operating-system/releases). 18.3 was current when this was written.
A newer version is fine; HA updates itself after install anyway.

### Option A: the Disks app (easiest)

1. Download the `.img.xz` in Firefox.
2. Open **Disks**. Select the **internal SSD** on the left. On the T8 Plus it's an NVMe drive of about 512 GB. **Don't** select the USB stick.
3. Click ⋮ → **Restore Disk Image…**, pick the `.img.xz`, and click **Start Restoring**.

### Option B: terminal (includes a disk check)

`homepanel setup` prints this same script. Change `DISK` to the name of your internal SSD:

```bash
wget https://github.com/home-assistant/operating-system/releases/download/18.3/haos_generic-x86-64-18.3.img.xz
lsblk -d -o NAME,SIZE,MODEL,TRAN          # find the INTERNAL SSD (e.g. nvme0n1), NOT the usb stick
DISK=nvme0n1                              # <- change to the internal SSD name from the list
# safety check: refuse USB disks and the disk the live system booted from
[ "$(lsblk -dno TRAN /dev/$DISK)" = "usb" ] && echo "STOP: $DISK is a USB disk" && exit 1
lsblk -no MOUNTPOINT /dev/$DISK | grep -qE '^/(cdrom|run/live|isodevice)' && echo "STOP: live USB" && exit 1
read -p "Erase EVERYTHING on /dev/$DISK ($(lsblk -dno SIZE,MODEL /dev/$DISK))? Type YES: " OK && [ "$OK" = YES ] || exit 1
xzcat haos_generic-x86-64-18.3.img.xz | sudo dd of=/dev/$DISK bs=4M status=progress conv=fsync
sync && echo "Done. Shut down, remove the USB stick, power on."
```

## 5. First boot

1. Shut down and unplug the USB stick.
2. Connect Ethernet. The T8 Plus has two ports and either one works. Power on.
3. The monitor shows the HA console with its IP address. The first start downloads the latest Home Assistant and
   takes **5–20 minutes**.
4. In your router, set up a **DHCP reservation** (sometimes called a *static lease*) for the mini PC's MAC address, so the IP never changes.
   Screens and PC agents connect to this IP.

## 6. Continue

Open `http://homeassistant.local:8123`. If that doesn't work, use `http://<ip>:8123`. Then run `homepanel setup` or
continue with [quickstart step 2](../quickstart.md#2-onboarding-5-min).

## Troubleshooting

- **The mini PC boots straight into Windows or "no boot device":** Secure Boot is still on, or the image went to the
  USB stick instead of the SSD. Check the BIOS boot order and look for "Home Assistant OS" or the NVMe drive.
- **The console shows no IP:** check the cable. HA OS has no Wi-Fi setup on the console, so use Ethernet.
- **`homeassistant.local` doesn't resolve:** some routers and Android devices don't support mDNS. Use the IP address.
- **Two network ports:** HA OS uses whichever port has a cable. If you plug in both, set the network in
  HA → Settings → System → Network.
