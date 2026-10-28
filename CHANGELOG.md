# Changelog

All notable changes are recorded here. Dates are UTC. The project follows
[Keep a Changelog](https://keepachangelog.com/) loosely and will use semver from v1.0.

## [Unreleased]: work in progress toward v1

### Added
- Public repo, MIT licence, SECURITY.md, STATUS.md, `device/secrets.example.h` (2026-10-27).
- v1 plan for the ESP32 panel: `docs/plans/v1-esp32-avatar.md`.
- Voice bridge: self-hosted xiaozhi server for the ESP32 voice panel, firmware served over the air, English panel build.
- Firmware patches for xiaozhi-esp32 v2.5.0 (`device/patches/`), including the louder-mic/AEC fix.
- three.js render layer: four telemetry signals drive a 3D capybara.
- Telemetry backend (Nourishment, Energy, Health) on loopback; Electron menu-bar app.

### Changed
- Speech threshold is measured from the room instead of being fixed at 350.
