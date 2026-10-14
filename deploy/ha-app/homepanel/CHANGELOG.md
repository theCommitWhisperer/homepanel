# Changelog

## 0.2.1
- Builds on current Home Assistant (Supervisor 2026.04+ no longer passes a base image; the Dockerfile
  now names it, build.yaml is gone) and from any branch, tag or commit.
- Serves the PC agent's Windows installer (`irm http://<ha-ip>:8080/agent/install.ps1 | iex`).
- Optional options that are not set are no longer passed as the text "null".
- Works with "Move the server to Home Assistant" in HomePanel setup (copies layouts from a PC).

## 0.1.0
- First release.
