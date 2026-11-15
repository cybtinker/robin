# Selling Fledgling Live on SD cards

Each card you sell only works as that card. Every SD card has a factory serial number (its CID)
built into the chip, and copying the card's contents does not copy that number. When you make a
card, `make-card` writes a licence file for that one serial, signed with your private seller key.
Fledgling Live checks the file when it starts:

| Situation | What the buyer gets |
| --- | --- |
| Original card | Full voice makeup, no time limit, works offline |
| Copy on another card, or no licence | 10-minute demo each time the app starts, then their plain voice |
| Edited licence file | Demo (the signature no longer matches) |

Nothing on a buyer's device is unbreakable. Someone skilled could patch the program. This is meant
to make copying more trouble than buying a card. A copied card even works as an advert, because it
runs the demo.

## What you need

- A Raspberry Pi with 64-bit Raspberry Pi OS whose **built-in SD slot is free**. Your Pi 500+ boots
  from its SSD, so its SD slot works. USB card readers hide the card serial and can't be used.
- The stock Raspberry Pi OS image (64-bit, with desktop) from raspberrypi.com/software/operating-systems.
- `sudo apt install build-essential libasound2-dev libsodium-dev parted`

## Once: your seller key

```sh
box/licence/make-card init
```

This creates `~/.fledgling/licence-private.pem`. **Back it up somewhere private**, for example a
password manager or a USB stick in a drawer. Without it you can't make cards that the released app
accepts. Never put it in the repo, on a card, or in an email.

## Once per release: the master image

```sh
sh box/desktop/build-deb.sh                                    # builds the app with your key inside
sudo box/licence/make-card image ~/Downloads/2025-xx-xx-raspios-bookworm-arm64.img.xz box/fledgling-live_0.2.0_arm64.deb
```

The result is `~/.fledgling/fledgling-master.img`: stock Raspberry Pi OS with Fledgling Live
installed. On first boot the buyer still gets the normal Raspberry Pi setup (country, Wi-Fi, their
own user name and password), and then it's an ordinary Pi to use however they like. The command
refuses an app that was built without your key.

## Per card (about 5 minutes)

```sh
sudo NOTE="etsy order 1234" box/licence/make-card flash /dev/mmcblk0
```

This writes the image, then the licence for that card's serial, and adds a line to
`~/.fledgling/cards.csv` (date, card serial, your note), so you have a record of every card sold.
To re-licence a card that's already flashed, for example after a buyer reflashed it with your
image, run `sudo box/licence/make-card licence /dev/mmcblk0`.

## Pi + card bundles

Optionally, a licence can also be tied to the Pi itself. That way the buyer can move to another
card and keep the voice makeup.

```sh
cat /sys/firmware/devicetree/base/serial-number               # on the Pi you're selling
box/licence/make-card pi 10000000abcdef01 >> fledgling.lic     # add the line to that card's licence
```

## Buyer support

- "It says Demo": the card isn't an original, or `fledgling.lic` was deleted from the card's boot
  partition. Re-licence the card (see above).
- To see what a Pi reports, run `fledgling-box --check-licence`. It prints the licence result and
  that machine's card and Pi serials.
