# Home Assistant Green

The Green ships with Home Assistant OS already installed, so you can skip the install step.

1. Connect it to your router with Ethernet, then plug in power.
2. Wait for the LEDs to settle. The first start takes about 5–10 minutes.
3. In your router, set a DHCP reservation for it.
4. Open `http://homeassistant.local:8123` (or `http://<ip>:8123`) and continue with
   [quickstart step 2](../quickstart.md#2-onboarding-5-min), or run `homepanel setup`.

## Notes

- The Green is an ARM (aarch64) device. The HomePanel app supports it, but the first build takes a while (roughly 10–20 minutes).
- It has USB ports for the ZBT-1. Use an extension cable.
- It has no HDMI output, so you can't use it as a screen itself.
