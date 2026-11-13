#!/bin/sh
# One command on a Pi 5 / Pi 500+ (Raspberry Pi OS with desktop):
#   sh desktop/install.sh
# Builds the Fledgling Live app and installs it. It then appears in the menu under Sound & Video.
set -e
BOX=$(cd "$(dirname "$0")/.." && pwd)
sudo apt-get update
sudo apt-get install -y build-essential libasound2-dev
sh "$BOX/desktop/build-deb.sh"
sudo apt-get install -y "$(ls -t "$BOX"/fledgling-live_*.deb | head -n1)"
echo
echo "Installed. Open it from the menu: Sound & Video > Fledgling Live (or run: fledgling-live)"
