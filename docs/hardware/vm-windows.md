# Only a Windows PC: Home Assistant OS in VirtualBox

This works, but **Home Assistant is off whenever the PC is off or asleep**. Lights still work from their own
apps, but HomePanel screens and automations stop. Use it to try things out, or until you buy a small dedicated box
(an N100 mini PC costs about the same as a few smart bulbs).

> Docker Desktop on Windows does **not** work for Home Assistant Container: it can't do host networking, USB or mDNS
> properly. Use VirtualBox (or Hyper-V) with HA OS instead.

## Automatic (recommended)

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

## By hand

1. Download `haos_ova-<version>.vdi.zip` from the
   [HA OS releases](https://github.com/home-assistant/operating-system/releases) and unzip it.
2. VirtualBox → **New**: name *HomeAssistant*, type *Linux*, version *Other Linux (64-bit)*, 4096 MB memory, 2 CPUs,
   **Enable EFI** ticked, *Use an existing virtual hard disk file* → the `.vdi`.
3. Settings → **Network** → Adapter 1: **Bridged Adapter**, set to your wired network card (Wi-Fi bridging works on most PCs, but not all).
4. Start it. After 5–20 minutes, open `http://homeassistant.local:8123` or the IP shown in the VM console.

## Keep it running

- Windows Settings → System → Power → **Sleep: Never** while plugged in.
- Start the VM automatically: put a shortcut to
  `"C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" startvm HomeAssistant --type headless`
  in `shell:startup`. This only runs once you log in. VirtualBox's autostart service is an alternative, but it's harder to set up.
- Shut down HA from inside HA first (Settings → System → ⋮ → Shut down), or run `VBoxManage controlvm HomeAssistant acpipowerbutton`.

## USB (ZBT-1)

Install the **VirtualBox Extension Pack** (same version as VirtualBox) for USB 2/3. Then go to VM Settings → USB → USB 3.0 →
add a filter for the ZBT-1 (*Nabu Casa / Home Assistant Connect ZBT-1*). Windows then gives up the stick to the VM.

## Monitoring this PC

The HomePanel agent runs on Windows next to the VM, like on any other PC. It connects to the MQTT broker inside the VM at
`mqtt://<vm-ip>:1883`. Because the VM uses a bridged network, it has its own LAN IP, separate from the PC's.
