# Security

Everything runs locally. The telemetry backend and the voice bridge's HTTP
service bind `127.0.0.1`; the board talks to the bridge over the LAN with a
per-install key and an optional device allowlist.

## Secrets

- **Never commit a secret.** WiFi credentials, keys and tokens live in
  gitignored files only.
- **Firmware:** copy `device/secrets.example.h` to `device/secrets.h` and fill it
  in. `secrets.h` is gitignored; only the example, with placeholders, is committed.
- **Voice bridge:** `ota_key` and `ws_token` are generated on first run into
  `~/Library/Application Support/voice-bridge/config.json` (outside the repo).
  A `config.json` inside the repo is gitignored as a safety net.
- **Signing:** Apple notarisation credentials come from the environment
  (see `docs/PACKAGING.md` placeholders), never from files in the repo.

## Reporting a problem

Please open a GitHub security advisory on this repo (Security → Report a
vulnerability) rather than a public issue.
