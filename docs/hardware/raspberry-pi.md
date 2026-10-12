# Home Assistant OS on a Raspberry Pi 4 or 5

A Pi 4 with 4 GB or more, or any Pi 5, runs Home Assistant and HomePanel well. Building the HomePanel app on a Pi is slow
the first time (expect 15+ minutes), but after that it runs fine.

**What you need:** a Pi 4 or 5 with its **official power supply**, Ethernet, and **one** of:
- a **USB SSD** (recommended: much more reliable than an SD card), or
- a good 32 GB+ **A2** SD card

## Steps

1. Install **Raspberry Pi Imager** (raspberrypi.com/software) on your computer.
2. **Choose device:** Raspberry Pi 4 or 5.
   **Choose OS:** *Other specific-purpose OS → Home assistants and home automation → Home Assistant → Home Assistant OS*.
   **Choose storage:** your SSD or SD card. Click **Write**.
3. Put the card or SSD in the Pi, connect Ethernet and power. The first start takes 5–20 minutes.
4. In your router, set a DHCP reservation for the Pi.
5. Open `http://homeassistant.local:8123` and continue with [quickstart step 2](../quickstart.md#2-onboarding-5-min),
   or run `homepanel setup` from any computer on the network.

## Notes

- **Booting from a USB SSD:** a Pi 5 and current Pi 4 firmware boot from USB by default. If a Pi 4 doesn't, flash
  *Misc utility images → Bootloader → USB Boot* to an SD card once.
- **ZBT-1:** use a USB extension cable and keep the stick away from the Pi's USB 3 (blue) ports and the SSD.
- **Image file names:** `haos_rpi4-64-<version>.img.xz` / `haos_rpi5-64-<version>.img.xz` on the HA OS releases page, if you
  prefer balenaEtcher to Pi Imager.
