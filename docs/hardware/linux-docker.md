# Linux box with Docker: HA Container + Mosquitto + HomePanel

Use this if you already have a Linux server you want to keep (home server, old laptop, Ubuntu on a mini PC).
You get Home Assistant **Container**, which has **no apps (add-ons)**. Mosquitto and HomePanel run as normal containers
instead, from [`deploy/compose.yaml`](../../deploy/compose.yaml).

## Requirements

- Linux (Debian, Ubuntu, Fedora, …) with **Docker Engine 23 or newer** and the **Compose plugin**.
- **Not Docker Desktop**, on any OS. HA needs host networking for discovery, plus USB access, and Docker Desktop runs containers
  inside a hidden VM where neither works.
- Run the installer **on that Linux box**.

## Automatic

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

## By hand

The steps are listed in the header of `deploy/compose.yaml`. In short:

```bash
mkdir -p ~/homepanel/mosquitto && cd ~/homepanel
cp <repo>/deploy/compose.yaml . && cp <repo>/deploy/mosquitto/mosquitto.conf mosquitto/
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
# onboard HA at http://<box>:8123, create a long-lived token (Profile → Security), put it in .env
docker compose up -d --build homepanel
```

Finally, in HA add the **MQTT** integration with broker `127.0.0.1`, port `1883`, user `homepanel` and the password above.

## Notes

- HA's config lives in `./homeassistant`. Back it up, because HA Container has no built-in backup scheduling the way HA OS does.
- **ZBT-1:** the HA container is `privileged`, so USB works. A tighter alternative is the `devices:` example in compose.yaml,
  using the `/dev/serial/by-id/...` path.
- Update everything with `docker compose pull && docker compose up -d`. For HomePanel, `git pull` and add `--build`.
