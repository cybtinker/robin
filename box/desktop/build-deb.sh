#!/bin/sh
# Build the Fledgling Live app as a Debian package for this machine (arm64 on a Pi 5 / Pi 500+).
#   sh desktop/build-deb.sh      ->  fledgling-live_<version>_<arch>.deb
set -e
VERSION=0.1.0
BOX=$(cd "$(dirname "$0")/.." && pwd)
ARCH=$(dpkg --print-architecture)
OUT="$BOX/fledgling-live_${VERSION}_${ARCH}.deb"
ST=$(mktemp -d)
trap 'rm -rf "$ST"' EXIT

make -C "$BOX" fledgling-box
install -D -m 755 "$BOX/fledgling-box"                  "$ST/usr/bin/fledgling-box"
install -D -m 755 "$BOX/desktop/fledgling-live"         "$ST/usr/bin/fledgling-live"
install -D -m 755 "$BOX/setup/fledgling-desktop.sh"     "$ST/usr/lib/fledgling-live/fledgling-desktop.sh"
install -D -m 644 "$BOX/ui/box_ui.py"                   "$ST/usr/lib/fledgling-live/box_ui.py"
install -D -m 644 "$BOX/ui/icon.png"                    "$ST/usr/lib/fledgling-live/icon.png"
install -D -m 644 "$BOX/ui/icon.png"                    "$ST/usr/share/icons/hicolor/512x512/apps/fledgling-live.png"
install -D -m 644 "$BOX/desktop/fledgling-live.desktop" "$ST/usr/share/applications/fledgling-live.desktop"
mkdir -p "$ST/usr/share/doc/fledgling-live"
printf 'Fledgling Live %s\nCopyright the Fledgling authors. All rights reserved.\n' "$VERSION" > "$ST/usr/share/doc/fledgling-live/copyright"

mkdir -p "$ST/DEBIAN"
cat > "$ST/DEBIAN/control" <<CTL
Package: fledgling-live
Version: $VERSION
Architecture: $ARCH
Maintainer: Fledgling <noreply@example.com>
Depends: libasound2 | libasound2t64, python3, python3-pygame, pipewire-pulse, pipewire-alsa, pulseaudio-utils
Section: sound
Priority: optional
Description: Live voice makeup for meetings
 Makes your voice younger, more confident or clearer in real time and offers it to
 Zoom, Teams, Meet and other apps as a microphone called "Fledgling Voice".
CTL
cat > "$ST/DEBIAN/postinst" <<'POST'
#!/bin/sh
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -f /usr/share/icons/hicolor || true
command -v update-desktop-database >/dev/null && update-desktop-database -q || true
exit 0
POST
chmod 755 "$ST/DEBIAN/postinst"
dpkg-deb --root-owner-group --build "$ST" "$OUT" >/dev/null
echo "built $OUT"
