#!/bin/sh
# Desktop mode (Pi 500+ / any Raspberry Pi OS desktop with PipeWire):
# makes a virtual microphone called "Fledgling Voice" and runs the voice engine into it.
# Meeting apps (Zoom, Teams, Meet in Chromium) then pick "Fledgling Voice" as the mic.
#
#   headset mic --> fledgling-box --> "Fledgling Voice" (virtual mic) --> Chromium meeting
#   meeting sound --> headset (PipeWire does this as normal)
#
# Runs as the desktop user (systemd --user service fledgling-desktop, set up by install-desktop.sh).
# Options: FLEDGLING_MIC=<PipeWire source name> to force a mic (see: pactl list short sources).
ENGINE=${FLEDGLING_ENGINE:-fledgling-box}
SINK=fledgling_engine_out      # where the engine plays; never pick this one yourself
SRC=fledgling_voice            # the virtual mic apps see

# wait for PipeWire's PulseAudio service after login
i=0; until pactl info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "PipeWire not running"; exit 1; }; sleep 1; done

pactl list short sinks | awk '{print $2}' | grep -qx $SINK ||
  pactl load-module module-null-sink sink_name=$SINK channels=1 rate=48000 \
    "sink_properties='device.description=\"Fledgling engine (not for apps)\"'" >/dev/null
pactl list short sources | awk '{print $2}' | grep -qx $SRC ||
  pactl load-module module-remap-source master=$SINK.monitor source_name=$SRC channels=1 \
    "source_properties='device.description=\"Fledgling Voice\"'" >/dev/null

find_mic() {
  [ -n "$FLEDGLING_MIC" ] && { echo "$FLEDGLING_MIC"; return; }
  pactl list short sources | awk '{print $2}' | grep '^alsa_input' | grep -i usb | head -n1
}
find_out() {
  pactl list short sinks | awk '{print $2}' | grep '^alsa_output' | grep -i usb | head -n1
}

echo "waiting for a USB headset..."
until MIC=$(find_mic) && [ -n "$MIC" ]; do sleep 2; done
echo "mic: $MIC"

# Apps get our voice by default; sound goes to the headset rather than our engine sink.
pactl set-default-source $SRC
OUT=$(find_out); [ -n "$OUT" ] && pactl set-default-sink "$OUT"

exec "$ENGINE" --no-listen --mic "pipewire:NODE=$MIC" --host "pipewire:NODE=$SINK" "$@"
