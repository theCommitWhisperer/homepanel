# Home Assistant OS in a VM on Proxmox or a NAS

Running **HA OS in a VM** gives you the full HA experience, apps included, on hardware you already run 24/7.
Give it **2 vCPU, 4 GB RAM, 32 GB disk**, **UEFI (OVMF)** firmware, and a **bridged** network.

## Proxmox VE

1. Download `haos_ova-<version>.qcow2.xz` from the
   [HA OS releases](https://github.com/home-assistant/operating-system/releases) and run `unxz` on it.
2. Create a VM: *OS: Do not use any media*, *System: Machine q35, BIOS OVMF (UEFI)*, add an EFI disk, and
   **untick "Pre-Enroll keys"** so Secure Boot stays off. Delete the default disk. 2 cores, 4096 MB, bridge `vmbr0`.
3. Import the disk: `qm importdisk <vmid> haos_ova-<version>.qcow2 local-lvm`. In *Hardware*, attach the unused disk
   (SCSI or SATA), then set it first in *Options → Boot Order*.
4. Start the VM. After 5–20 minutes, open `http://<vm-ip>:8123`.

The community **"Home Assistant OS VM"** helper script (community-scripts.github.io/ProxmoxVE) automates all of this. It
is popular, but it's a third-party script that runs as root, so read it before running it.

**ZBT-1:** in the VM's *Hardware → Add → USB Device*, choose *Use USB Vendor/Device ID* and pick the ZBT-1.

## Synology (DSM 7, Virtual Machine Manager)

1. Download `haos_ova-<version>.ova`.
2. Virtual Machine Manager → **Virtual Machine → Create → Import** → *Import from OVA files*. 2 vCPU, 4 GB, and select **UEFI**
   if asked.
3. USB passthrough of the ZBT-1 works on some models only. If it doesn't on yours, consider a network Zigbee coordinator instead.

## Unraid / TrueNAS SCALE

Create a VM with UEFI firmware, attach the `qcow2` as the boot disk (VirtIO or SATA), and use a bridged network. Add the ZBT-1 as a USB device.

## HomePanel

Once HA is running, everything is the same as on a mini PC: run `homepanel setup` from any computer on your network, or follow the
[quickstart](../quickstart.md) from step 2.

> Running **HA Container** in Docker on the NAS also works (see [linux-docker.md](linux-docker.md)), but Synology's
> Container Manager is a Docker *Engine*, and HA's discovery needs `network_mode: host`. Some NAS UIs hide that option.
