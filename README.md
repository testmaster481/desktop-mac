# S10 Telemedicine Desktop

Electron wrapper for https://telemedicine.s10technologies.in/ with camera, microphone,
screen sharing, clipboard, notifications and geolocation enabled.

## Run
    npm install
    npm start

## Build installers
    npm run build:win     # NSIS .exe  (run on Windows)
    npm run build:mac     # dmg + zip  (run on macOS)
    npm run build:linux   # AppImage + deb

## Config (environment variables)
- `S10_HOME_URL`       – override the portal URL (e.g. staging)
- `S10_EXTRA_ORIGINS`  – comma-separated extra origins to trust (e.g. a separate media server)

## Notes
- Permissions are granted only to https://*.s10technologies.in and S10_EXTRA_ORIGINS.
- macOS: first launch prompts for camera/mic. Screen sharing needs
  System Settings → Privacy & Security → Screen & System Audio Recording.
- Linux/Wayland: screen sharing uses PipeWire (xdg-desktop-portal must be installed).
- Windows: sharing a screen also shares system audio when the site requests audio.
- Toolbar: Ctrl/Cmd+Shift+T toggles it. DevTools: Ctrl/Cmd+Shift+I.
