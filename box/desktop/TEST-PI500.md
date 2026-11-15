# Testing Fledgling Live on a Pi 500+ (or any Pi 5)

About 15 minutes. You need: the Pi 500+ on Raspberry Pi OS **with desktop**, an HDMI screen,
a USB headset, and (optional) a USB webcam.

## 1. Install (one command)

Open a Terminal (menu → Accessories → Terminal) and paste:

```sh
git clone https://github.com/cybtinker/robin && cd robin && git checkout claude/project-thread-bpoum6 && sh box/desktop/install.sh
```

It asks for your password, builds the app (about a minute) and installs it.
(Once the pull request is merged you can leave out the `git checkout` part.)

## 2. Open it

Plug in the USB headset, then open **menu → Sound & Video → Fledgling Live**.
The window shows the four sliders. At the top it should say
*In your meeting, pick the mic "Fledgling Voice"*. If it says *Plug in a USB headset*, unplug and
replug the headset.

## 3. Hear yourself

Click **Hear myself** and talk. You hear your made-up voice in the headset (with a small delay;
that delay is only in your ears, not in the meeting). Move the sliders while you talk.
**Makeup ON / OFF** at the top right compares with your own voice. Click **Hear myself** again to stop.

## 4. Try a meeting

1. Open Chromium and go to a test call:
   - Google Meet: https://meet.google.com → New meeting (or the "Check your audio and video" screen)
   - Zoom: https://zoom.us/test → Join from your browser
   - Teams: https://teams.live.com → Meet now
2. When the site asks, allow the microphone and camera.
3. In the site's audio settings, the microphone should be **Fledgling Voice** (it is the default
   while the app is open). The speaker should be your headset.
4. Use the site's mic test, or join from your phone too, to hear how you sound to others.

## 5. Tell us

- Did "Fledgling Voice" show up, and did people hear the made-up voice?
- Any crackles or dropouts? If so, run this in a Terminal while it happens and send the output:
  `echo stat | nc -u -w1 127.0.0.1 9555` (look at `xruns=`)
- Does the delay feel OK in a conversation?
- Which slider settings sounded best on you?

## If something goes wrong

- Log: `cat $XDG_RUNTIME_DIR/fledgling-live.log`
- Wrong mic picked up: `pactl list short sources`, then start it with
  `FLEDGLING_MIC=<name> fledgling-live`
- Meeting sites clean up the mic (noise suppression, auto gain). If the effect sounds weaker in
  the meeting than in **Hear myself**, turn off noise suppression in the site's audio settings.
- Closing the window turns the makeup off and removes the "Fledgling Voice" mic.
- Remove the app: `sudo apt remove fledgling-live`
