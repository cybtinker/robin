#!/usr/bin/env python3
"""Fledgling Live: touch-screen controls for the voice box (pygame, fullscreen).

Talks to the fledgling-box engine over UDP on 127.0.0.1:9555. Works on any screen size
(5-inch 800x480 landscape, or 720x1280 portrait). Settings are kept in
~/.config/fledgling-box/settings.json and sent to the engine at start.

Run:  python3 box_ui.py            (fullscreen)
      python3 box_ui.py --window   (800x480 window, for a desktop)
      python3 box_ui.py --shot out.png   (render one frame without a screen, for docs)
"""
import json, os, socket, sys, time

if '--shot' in sys.argv:
    os.environ['SDL_VIDEODRIVER'] = 'dummy'
os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')
import pygame

PORT = 9555
CFG = os.path.expanduser('~/.config/fledgling-box/settings.json')
DEFAULTS = {'age': 50, 'conf': 40, 'tone': 30, 'gender': 0, 'on': True, 'voice': 'auto', 'monitor': 0}

# the app's dark palette
BG, PANEL, INK, MUTED, LINE = (22, 20, 26), (33, 30, 38), (241, 236, 230), (163, 154, 166), (52, 48, 58)
ACCENT, OFF = (76, 194, 174), (240, 96, 76)
LOOKS = [  # id, left, right, tint (same as the app)
    ('age', 'Older', 'Younger', (217, 239, 233)),
    ('conf', 'Timid', 'Confident', (230, 233, 247)),
    ('tone', 'Breathy', 'Clear', (243, 227, 239)),
    ('gender', 'Masculine', 'Feminine', (247, 233, 214)),
]


def load():
    try:
        with open(CFG) as f:
            s = json.load(f)
        return {**DEFAULTS, **{k: s[k] for k in DEFAULTS if k in s}}
    except Exception:
        return dict(DEFAULTS)


def save(s):
    try:
        os.makedirs(os.path.dirname(CFG), exist_ok=True)
        with open(CFG + '.tmp', 'w') as f:
            json.dump(s, f)
        os.replace(CFG + '.tmp', CFG)
    except Exception as e:
        print('could not save settings:', e, file=sys.stderr)


class Engine:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(0.05)
        self.stat = {}

    def send(self, cmd):
        try:
            self.sock.sendto(cmd.encode(), ('127.0.0.1', PORT))
            return self.sock.recv(1024).decode()
        except OSError:
            return ''

    def push(self, s):
        self.send('looks %d %d %d %d' % (s['age'], s['conf'], s['tone'], s['gender']))
        self.send('bypass %d' % (0 if s['on'] else 1))
        self.send('voice ' + s['voice'])
        self.send('monitor %d' % s['monitor'])

    def poll(self):
        r = self.send('stat')
        st = {}
        for kv in r.split():
            if '=' in kv:
                k, v = kv.split('=', 1)
                try:
                    st[k] = float(v)
                except ValueError:
                    st[k] = v
        self.stat = st
        return st


def words(v):
    a = abs(v)
    return 'Off' if a == 0 else 'Light' if a < 35 else 'Medium' if a < 70 else 'Strong'


class UI:
    def __init__(self, screen, engine, settings):
        self.scr, self.eng, self.s = screen, engine, settings
        self.drag = None
        self.dirty_save = 0
        self.layout()

    def layout(self):
        W, H = self.scr.get_size()
        self.W, self.H = W, H
        u = min(W, H) / 480.0            # scale unit
        self.u = u
        self.f_big = pygame.font.Font(None, int(44 * u))
        self.f_mid = pygame.font.Font(None, int(32 * u))
        self.f_small = pygame.font.Font(None, int(25 * u))
        pad = int(16 * u)
        self.pad = pad
        top = int(64 * u)
        bottom = int(92 * u)
        rows_h = H - top - bottom
        rh = rows_h / len(LOOKS)
        self.rows = []
        for i, (lid, l, r, tint) in enumerate(LOOKS):
            y = top + i * rh
            track = pygame.Rect(pad + int(130 * u), int(y + rh * 0.5 - 7 * u), W - 2 * pad - int(260 * u), int(14 * u))
            self.rows.append((lid, l, r, tint, pygame.Rect(0, int(y), W, int(rh)), track))
        self.btn_on = pygame.Rect(W - pad - int(150 * u), int(10 * u), int(150 * u), int(46 * u))
        by = H - bottom + int(14 * u)
        bw = int(84 * u)
        self.btn_voice = [(v, pygame.Rect(pad + i * (bw + int(6 * u)), by + int(30 * u), bw, int(44 * u)))
                          for i, v in enumerate(['auto', 'low', 'high'])]
        x2 = pad + 3 * (bw + int(6 * u)) + int(18 * u)
        self.btn_mon = pygame.Rect(x2, by + int(30 * u), int(170 * u), int(44 * u))
        self.btn_reset = pygame.Rect(x2 + int(180 * u), by + int(30 * u), int(110 * u), int(44 * u))
        self.meter = pygame.Rect(W - pad - int(150 * u), by + int(30 * u), int(150 * u), int(44 * u))
        self.label_y = by

    def text(self, s, font, col, pos, anchor='topleft'):
        img = font.render(s, True, col)
        r = img.get_rect(**{anchor: pos})
        self.scr.blit(img, r)
        return r

    def button(self, rect, label, active, col=ACCENT):
        pygame.draw.rect(self.scr, col if active else PANEL, rect, border_radius=int(12 * self.u))
        pygame.draw.rect(self.scr, col if active else LINE, rect, 2, border_radius=int(12 * self.u))
        self.text(label, self.f_small, BG if active else INK, rect.center, 'center')

    def draw(self):
        s, st, u, pad = self.s, self.eng.stat, self.u, self.pad
        self.scr.fill(BG)
        self.text('Fledgling Live', self.f_big, INK, (pad, int(16 * u)))
        # connection status
        ok_t, ok_l = st.get('talk', 0) == 1, st.get('listen', 0) == 1
        if not st:
            msg, col = 'Engine not running', OFF
        elif ok_t and ok_l:
            msg, col = 'Headset and phone connected', ACCENT
        elif ok_t:
            msg, col = 'Talking (phone audio not playing)', ACCENT
        else:
            msg, col = 'Plug in headset and phone', OFF
        x = pad + int(250 * u)
        pygame.draw.circle(self.scr, col, (x, int(34 * u)), int(7 * u))
        self.text(msg, self.f_small, MUTED, (x + int(14 * u), int(26 * u)))
        self.button(self.btn_on, 'Makeup ON' if s['on'] else 'Makeup OFF', s['on'], ACCENT if s['on'] else OFF)
        # sliders
        for lid, l, r, tint, row, tr in self.rows:
            v = s[lid]
            dim = not s['on']
            self.text(l, self.f_mid, MUTED if dim else INK, (pad, tr.centery), 'midleft')
            self.text(r, self.f_mid, MUTED if dim else INK, (self.W - pad, tr.centery), 'midright')
            pygame.draw.rect(self.scr, LINE, tr, border_radius=tr.h // 2)
            cx = tr.centerx
            kx = cx + v / 100.0 * tr.w / 2
            fill = pygame.Rect(min(cx, kx), tr.y, abs(kx - cx), tr.h)
            pygame.draw.rect(self.scr, tint if not dim else MUTED, fill, border_radius=tr.h // 2)
            pygame.draw.line(self.scr, MUTED, (cx, tr.y - int(6 * u)), (cx, tr.bottom + int(6 * u)), 2)
            pygame.draw.circle(self.scr, INK, (int(kx), tr.centery), int(17 * u))
            pygame.draw.circle(self.scr, tint, (int(kx), tr.centery), int(13 * u))
            side = r if v > 0 else l
            self.text('Off' if v == 0 else '%s %s' % (words(v), side.lower()), self.f_small, MUTED,
                      (cx, tr.y - int(10 * u)), 'midbottom')
        # bottom bar
        pygame.draw.line(self.scr, LINE, (0, self.label_y), (self.W, self.label_y), 1)
        vlabel = 'My voice'
        if s['voice'] == 'auto' and st.get('voice'):
            vlabel += ' (sounds %s)' % st['voice']
        self.text(vlabel, self.f_small, MUTED, (pad, self.label_y + int(8 * u)))
        for v, rect in self.btn_voice:
            self.button(rect, v.capitalize(), s['voice'] == v)
        self.button(self.btn_mon, 'Hear myself' if s['monitor'] else 'Hear myself: off', s['monitor'] > 0)
        self.button(self.btn_reset, 'Reset', False)
        # level meter (output) + latency
        m = self.meter
        pygame.draw.rect(self.scr, PANEL, m, border_radius=int(8 * u))
        lvl = st.get('out', -120.0)
        frac = max(0.0, min(1.0, (lvl + 60) / 60))
        pygame.draw.rect(self.scr, ACCENT if lvl < -3 else OFF, (m.x, m.y, int(m.w * frac), m.h), border_radius=int(8 * u))
        lat = st.get('latency_ms')
        self.text('Level' + ('   ~%d ms' % lat if lat else ''), self.f_small, MUTED, (m.x, self.label_y + int(8 * u)))

    def hit_slider(self, pos):
        for lid, l, r, tint, row, tr in self.rows:
            if row.collidepoint(pos) and tr.x - 30 * self.u <= pos[0] <= tr.right + 30 * self.u:
                return lid, tr
        return None

    def set_from_x(self, lid, tr, x):
        v = round((x - tr.centerx) / (tr.w / 2) * 100)
        v = max(-100, min(100, v))
        if abs(v) <= 5:
            v = 0  # snap to off, as in the app
        if v != self.s[lid]:
            self.s[lid] = v
            self.eng.send('looks %d %d %d %d' % (self.s['age'], self.s['conf'], self.s['tone'], self.s['gender']))
            self.dirty_save = time.time()

    def click(self, pos):
        s = self.s
        if self.btn_on.collidepoint(pos):
            s['on'] = not s['on']
            self.eng.send('bypass %d' % (0 if s['on'] else 1))
        elif self.btn_mon.collidepoint(pos):
            s['monitor'] = 0 if s['monitor'] else 35
            self.eng.send('monitor %d' % s['monitor'])
        elif self.btn_reset.collidepoint(pos):
            for k in ('age', 'conf', 'tone', 'gender'):
                s[k] = DEFAULTS[k]
            self.eng.push(s)
        else:
            for v, rect in self.btn_voice:
                if rect.collidepoint(pos):
                    s['voice'] = v
                    self.eng.send('voice ' + v)
            h = self.hit_slider(pos)
            if h:
                self.drag = h
                self.set_from_x(h[0], h[1], pos[0])
                return
        self.dirty_save = time.time()


def main():
    pygame.display.init()  # not pygame.init(): the mixer must not grab the sound cards
    pygame.font.init()
    shot = sys.argv[sys.argv.index('--shot') + 1] if '--shot' in sys.argv else None
    if shot or '--window' in sys.argv:
        scr = pygame.display.set_mode((800, 480))
    else:
        scr = pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
        pygame.mouse.set_visible(False)
    pygame.display.set_caption('Fledgling Live')
    eng = Engine()
    s = load()
    eng.push(s)
    ui = UI(scr, eng, s)
    if shot:
        eng.stat = {'talk': 1, 'listen': 1, 'voice': 'low', 'out': -18.0, 'latency_ms': 32}
        ui.draw()
        pygame.image.save(scr, shot)
        return
    clock = pygame.time.Clock()
    last_poll = 0
    while True:
        for e in pygame.event.get():
            if e.type == pygame.QUIT or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                save(s)
                return
            if e.type == pygame.MOUSEBUTTONDOWN:
                ui.click(e.pos)
            elif e.type == pygame.MOUSEMOTION and ui.drag and e.buttons[0]:
                ui.set_from_x(ui.drag[0], ui.drag[1], e.pos[0])
            elif e.type == pygame.MOUSEBUTTONUP:
                ui.drag = None
        now = time.time()
        if now - last_poll > 0.2:
            if not eng.stat:
                eng.push(s)  # engine (re)started: send our settings again
            eng.poll()
            last_poll = now
        if ui.dirty_save and now - ui.dirty_save > 1.0:
            save(s)
            ui.dirty_save = 0
        ui.draw()
        pygame.display.flip()
        clock.tick(30)


if __name__ == '__main__':
    main()
