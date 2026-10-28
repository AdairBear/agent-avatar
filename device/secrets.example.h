// Copy to secrets.h (gitignored) and fill in. Never commit secrets.h.
// The stock xiaozhi firmware provisions WiFi over its captive portal; these
// are only for builds that bake credentials in.
#pragma once

#define WIFI_SSID      "REPLACE_WITH_SSID"
#define WIFI_PASSWORD  "REPLACE_WITH_WIFI_PASSWORD"
// Bridge OTA URL, e.g. http://<mac-lan-address>:8790/xiaozhi/ota/?k=<ota_key>
#define OTA_URL        "REPLACE_WITH_OTA_URL"
