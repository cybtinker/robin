#!/bin/sh
# Desktop mode (Pi 400, Pi 4, Pi 5, Pi 500+: Raspberry Pi OS Bookworm or newer, which uses PipeWire):
# makes a virtual microphone called "Fledgling Voice" and runs the voice engine into it.
# Meeting and recording apps (Zoom, Teams, Meet in Chromium, OBS, Audacity) then use "Fledgling Voice".
#
#   headset mic --> fledgling-box --> "Fledgling Voice" (virtual mic) --> Chromium meeting
#   meeting sound --> headset (PipeWire does this as normal)
#
# Started by the fledgling-live launcher as the desktop user.
# Options: FLEDGLING_MIC=<PipeWire source name> to force a mic (see: pactl list short sources).
ENGINE=${FLEDGLING_ENGINE:-fledgling-box}
SINK=fledgling_engine_out      # where the engine plays; never pick this one yourself
SRC=fledgling_voice            # the virtual mic apps see

# wait for PipeWire's PulseAudio service after login
i=0; until pactl info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "PipeWire not running"; exit 1; }; sleep 1; done
LC_ALL=C pactl info | grep -q 'Server Name:.*PipeWire' ||
  { echo "This needs PipeWire (Raspberry Pi OS Bookworm or newer). Older systems use PulseAudio."; exit 1; }

pactl list short sinks | awk '{print $2}' | grep -qx $SINK ||
  pactl load-module module-null-sink sink_name=$SINK channels=1 rate=48000 \
    "sink_properties='device.description=\"Fledgling engine (not for apps)\"'" >/dev/null
pactl list short sources | awk '{print $2}' | grep -qx $SRC ||
  pactl load-module module-remap-source master=$SINK.monitor source_name=$SRC channels=1 \
    "source_properties='device.description=\"Fledgling Voice\"'" >/dev/null

# The app window picks the mic (a USB or Bluetooth headset first, a webcam mic last) and switches
# it when headsets come and go, so the engine starts with no mic. FLEDGLING_MIC forces one.
MIC=none; [ -n "$FLEDGLING_MIC" ] && MIC="pipewire:NODE=$FLEDGLING_MIC"

# Apps get our voice by default; call sound goes to a USB headset if there is one (else as before).
pactl set-default-source $SRC
OUT=$(pactl list short sinks | awk '{print $2}' | grep '^alsa_output' | grep -i usb | head -n1)
[ -n "$OUT" ] && pactl set-default-sink "$OUT"

# If the mic we record from disappears, PipeWire must not quietly move us to the default source,
# which is our own "Fledgling Voice" (that would loop our output back into the engine).
export PIPEWIRE_PROPS='{ node.dont-reconnect = true node.dont-fallback = true node.dont-move = true }'
exec "$ENGINE" --no-listen --mic "$MIC" --host "pipewire:NODE=$SINK" "$@"
