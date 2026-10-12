# Zigbee with the Home Assistant Connect ZBT-1

The ZBT-1 (formerly *SkyConnect*) is a USB radio for **Zigbee** or **Thread**. Most Zigbee bulbs, plugs and sensors
work with it through Home Assistant's built-in **ZHA** integration.

## 1. Placement matters

- Use a **USB extension cable** (0.5–1 m) so the stick sits away from the computer.
- Prefer a **USB 2** port. USB 3 ports and SSDs give off noise in the 2.4 GHz band that Zigbee uses.
- Keep it a little away from your Wi-Fi router.

Poor placement is the most common reason Zigbee devices drop off.

## 2. Add it to Home Assistant

1. Plug it in. After about 30 s, HA → **Settings → Devices & services** shows *Discovered: Home Assistant Connect ZBT-1*.
2. Click **Add**. HA asks how to use the stick: choose **Zigbee**.
   HA flashes Zigbee firmware if needed and sets up **ZHA**.
3. Click Submit, and when ZHA asks, accept the default network settings.

`homepanel setup --step zigbee` checks whether the stick has been discovered or ZHA is already set up, and then shows these
steps. The radio choice is made in HA's own dialog, not by the installer.

## 3. Pair devices

Settings → Devices & services → **Zigbee Home Automation → Add device**, then put the device in pairing mode
(usually a reset: turn bulbs on and off 5–6 times, or hold a sensor's button). **Pair mains-powered devices (bulbs, plugs) first.**
They act as repeaters and extend the network for battery sensors.

## VMs and Docker

- **Proxmox / VirtualBox:** pass the USB device through to the HA VM (see the [hardware guides](hardware/)).
- **Docker:** the compose file runs HA privileged. You can also map only `/dev/serial/by-id/usb-Nabu_Casa_…`.

## Thread / Matter instead?

You can use the ZBT-1 for Thread instead of Zigbee, but the firmware does one or the other. A second stick for Thread is the
simple option. The multiprotocol (both at once) firmware was experimental and has been deprecated by Nabu Casa.
