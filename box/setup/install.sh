#!/bin/sh
# One-time setup on Raspberry Pi OS (Bookworm or later, Lite or Desktop) on a Pi 4B.
#   git clone https://github.com/cybtinker/robin && cd robin/box && sudo sh setup/install.sh
# Then power off, wire it up (README), and power on. Safe to run again after a git pull.
set -e
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
BOX=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=${SUDO_USER:-pi}
CFG=/boot/firmware/config.txt; [ -f $CFG ] || CFG=/boot/config.txt

echo "== packages"
apt-get update
apt-get install -y build-essential libasound2-dev python3-pygame

echo "== build"
make -C "$BOX"
install -m 755 "$BOX/fledgling-box" /usr/local/bin/fledgling-box
install -m 755 "$BOX/setup/usb-gadget.sh" /usr/local/bin/fledgling-gadget

echo "== USB-C port as a USB sound card (device mode)"
grep -q '^dtoverlay=dwc2' $CFG || printf '\n[all]\ndtoverlay=dwc2,dr_mode=peripheral\n' >> $CFG
grep -q '^libcomposite' /etc/modules || echo libcomposite >> /etc/modules

echo "== services"
cat > /etc/systemd/system/fledgling-gadget.service <<UNIT
[Unit]
Description=Fledgling USB sound card gadget
After=sys-kernel-config.mount
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/fledgling-gadget
ExecStop=/usr/local/bin/fledgling-gadget stop
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/fledgling-box.service <<UNIT
[Unit]
Description=Fledgling live voice engine
After=fledgling-gadget.service sound.target
Wants=fledgling-gadget.service
[Service]
ExecStart=/usr/local/bin/fledgling-box
Restart=always
RestartSec=1
User=$USER_NAME
SupplementaryGroups=audio
LimitRTPRIO=95
LimitMEMLOCK=infinity
Nice=-10
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/fledgling-ui.service <<UNIT
[Unit]
Description=Fledgling touch-screen controls
After=fledgling-box.service
[Service]
ExecStart=/usr/bin/python3 $BOX/ui/box_ui.py
Restart=always
RestartSec=2
User=$USER_NAME
SupplementaryGroups=video input render
Environment=SDL_VIDEODRIVER=kmsdrm
[Install]
WantedBy=multi-user.target
UNIT

# On the Desktop image the desktop owns the screen: start the UI from the desktop session instead.
if systemctl is-enabled lightdm >/dev/null 2>&1 || systemctl is-enabled gdm3 >/dev/null 2>&1; then
  mkdir -p /home/$USER_NAME/.config/autostart
  cat > /home/$USER_NAME/.config/autostart/fledgling-ui.desktop <<DESK
[Desktop Entry]
Type=Application
Name=Fledgling Live
Exec=python3 $BOX/ui/box_ui.py
DESK
  chown -R $USER_NAME /home/$USER_NAME/.config/autostart
  UI_UNIT=""
else
  UI_UNIT=fledgling-ui.service
fi

systemctl daemon-reload
systemctl enable fledgling-gadget.service fledgling-box.service $UI_UNIT
echo
echo "Done. Power off, connect the headset (USB-A port) and the phone/computer (USB-C port, through"
echo "the power splitter), then power on. Logs: journalctl -u fledgling-box -f"
