# Remote access with Tailscale

Tailscale connects your devices in a private network that works from anywhere. You don't open ports on your router,
and Home Assistant and HomePanel aren't exposed to the internet. It's free for personal use.

## On Home Assistant OS

1. HA → Settings → **Apps → App store → ⋮ → Repositories**. Make sure the **Home Assistant Community Apps** repository
   (`https://github.com/hassio-addons/repository`) is listed. It usually is by default.
2. Install **Tailscale** (slug `a0d7b954_tailscale`), turn on *Start on boot*, and click **Start**.
   `homepanel setup --step remote` does these two steps through the Supervisor API.
3. Open the app's **Web UI** and log in to Tailscale. In the Tailscale admin console, approve the machine and **disable key expiry**
   for it, so it doesn't drop off after 6 months.
4. Install Tailscale on your phone and laptop, and log in with the same account.
5. From anywhere: `http://homeassistant:8123` (HA) and `http://homeassistant:8080` (HomePanel). This uses the MagicDNS
   name, which matches the HA host name. You can also use the `100.x.y.z` address shown in Tailscale.

## On a Docker host

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then use the host's Tailscale name with ports 8123 and 8080.

## What HomePanel does with remote connections

HomePanel marks devices that connect from outside your home network as **remote**. Buttons and PC actions marked
`home-only` are refused for them, so nobody can, for example, unlock a door or shut down the gaming PC from outside, even with a paired phone.

## Alternatives

- **Home Assistant Cloud (Nabu Casa)** gives remote access to HA's own UI. It doesn't cover HomePanel on port 8080.
- **Cloudflare Tunnel** and reverse proxies work, but put HomePanel on the public internet. If you go that way, put
  an access layer such as Cloudflare Access in front of it.
