#!/bin/sh
# Make the Pi's USB-C port show up as a USB sound card ("Fledgling Live Voice") to the phone or
# computer: a mic (our made-up voice) and a speaker (the call audio, sent on to your headset).
# Needs dtoverlay=dwc2,dr_mode=peripheral in /boot/firmware/config.txt (install.sh adds it).
# Run as root at boot (fledgling-gadget.service). Run with "stop" to remove the gadget.
set -e
G=/sys/kernel/config/usb_gadget/fledgling

if [ "$1" = "stop" ]; then
  [ -d $G ] || exit 0
  echo "" > $G/UDC 2>/dev/null || true
  rm -f $G/configs/c.1/uac2.usb0
  rmdir $G/configs/c.1/strings/0x409 $G/configs/c.1 $G/functions/uac2.usb0 $G/strings/0x409 $G 2>/dev/null || true
  exit 0
fi

modprobe libcomposite
[ -d $G ] && exit 0
mkdir -p $G && cd $G
echo 0x1d6b > idVendor      # Linux Foundation (fine for a prototype; a product needs its own IDs)
echo 0x0104 > idProduct     # Multifunction Composite Gadget
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB
mkdir -p strings/0x409
echo "Fledgling"            > strings/0x409/manufacturer
echo "Fledgling Live Voice" > strings/0x409/product
cat /proc/device-tree/serial-number 2>/dev/null | tr -d '\0' > strings/0x409/serialnumber || echo 0001 > strings/0x409/serialnumber

mkdir -p functions/uac2.usb0
F=functions/uac2.usb0
# p_* = what the phone records (our mic): mono, 48 kHz, 16-bit
echo 1     > $F/p_chmask
echo 48000 > $F/p_srate
echo 2     > $F/p_ssize
# c_* = what the phone plays (call audio): stereo, 48 kHz, 16-bit
echo 3     > $F/c_chmask
echo 48000 > $F/c_srate
echo 2     > $F/c_ssize
# newer kernels: name the device, no volume/mute controls (the phone's own sliders are enough)
[ -e $F/function_name ] && echo "Fledgling Live Voice" > $F/function_name || true
for f in p_volume_present c_volume_present p_mute_present c_mute_present; do
  [ -e $F/$f ] && echo 0 > $F/$f || true
done

mkdir -p configs/c.1/strings/0x409
echo "Voice box" > configs/c.1/strings/0x409/configuration
echo 0xC0 > configs/c.1/bmAttributes   # self-powered: the box has its own supply
echo 2 > configs/c.1/MaxPower           # ask the phone for (almost) no power, so iPhones accept it
ln -s $F configs/c.1/

ls /sys/class/udc | head -n1 > UDC
echo "USB sound card gadget ready on $(cat UDC)"
