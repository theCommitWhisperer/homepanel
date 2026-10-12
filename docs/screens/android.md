# Android tablet as a HomePanel screen

1. Install **Fully Kiosk Browser** from Google Play.
2. Settings → Web Content → **Start URL** `http://<homepanel-ip>:8080`. Turn on **Keep Screen On** and **Launch on Boot**.
   Turn on **Kiosk Mode** (PLUS) if you want to lock the tablet to HomePanel.
3. Approve the 6-digit code at `http://<homepanel-ip>:8080/admin` → Devices, and choose a profile.

Free alternative: Chrome → ⋮ → **Add to Home screen / Install app**, plus Android's **App pinning**
(Settings → Security → App pinning). This works, but it can't wake the screen or stop the tablet from sleeping as reliably as Fully.

For slow or older tablets, use a profile with `lite: true`.

Waking the screen on a doorbell ring needs Fully PLUS remote admin. See [fire-hd8.md](fire-hd8.md#5-optional-wake-the-screen-when-the-doorbell-rings-fully-plus).
