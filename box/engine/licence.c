/* Fledgling Live licence check.
 *
 * The licence file (fledgling.lic on the SD card's boot partition) holds one or more lines:
 *     cid <card id hex> <ed25519 signature hex>
 *     serial <pi serial hex> <ed25519 signature hex>
 * The signature covers "fledgling-live/1 <kind> <id>". It is made by make-card with the seller's
 * private key, which never leaves the seller's computer; only the public key is built in here.
 *
 * "cid" is the SD card's factory serial (register CID, read only, not copied when the card is
 * cloned). "serial" is the Raspberry Pi board serial, for Pi + card bundles.
 * Not unbreakable (nothing on the buyer's device is): it only makes copying a card useless.
 */
#define _GNU_SOURCE
#include "licence.h"
#include "licence_key.h"            /* generated: static const unsigned char LICENCE_PK[32] */
#include <ctype.h>
#include <dirent.h>
#include <sodium.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *DEFAULT_FILES[] = { "/boot/firmware/fledgling.lic", "/boot/fledgling.lic", NULL };

static void lower(char *s) { for (; *s; s++) *s = (char)tolower((unsigned char)*s); }

static int read_line(const char *path, char *buf, size_t n) {
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  size_t k = fread(buf, 1, n - 1, f); fclose(f);
  buf[k] = 0;
  while (k && (buf[k - 1] == '\n' || buf[k - 1] == '\r' || buf[k - 1] == 0)) buf[--k] = 0;
  return k > 0;
}

/* Someone could bind-mount a fake id file over /sys or /proc; refuse if anything is mounted there
 * beyond the normal sysfs/proc/configfs/debugfs mounts. */
static int ids_tampered(void) {
  FILE *f = fopen("/proc/self/mountinfo", "r");
  if (!f) return 0;
  char line[1024]; int bad = 0;
  while (fgets(line, sizeof line, f)) {
    char mp[512];
    if (sscanf(line, "%*s %*s %*s %*s %511s", mp) != 1) continue;
    static const char *watch[] = { "/sys/block", "/sys/devices", "/sys/firmware", "/sys/bus", "/sys/class",
                                   "/proc/device-tree", "/proc/cpuinfo", NULL };
    for (int i = 0; watch[i]; i++) if (!strncmp(mp, watch[i], strlen(watch[i]))) bad = 1;
  }
  fclose(f);
  return bad;
}

int licence_ids(char *out, size_t n) {
  size_t used = 0; out[0] = 0;
  char p[512], v[128];
#ifdef LICENCE_TEST
  const char *root = getenv("FLEDGLING_SYSROOT");      /* test builds only: read ids from a fake tree */
  if (!root) root = "";
#else
  const char *root = "";
#endif
  snprintf(p, sizeof p, "%s/sys/block", root);
  DIR *d = opendir(p);
  if (d) {
    struct dirent *e;
    while ((e = readdir(d))) {
      if (strncmp(e->d_name, "mmcblk", 6) || strchr(e->d_name + 6, 'b')) continue;   /* skip mmcblk0boot0 */
      snprintf(p, sizeof p, "%s/sys/block/%s/device/cid", root, e->d_name);
      if (read_line(p, v, sizeof v)) { lower(v); used += snprintf(out + used, used < n ? n - used : 0, "cid %s\n", v); }
    }
    closedir(d);
  }
  const char *sp[] = { "/sys/firmware/devicetree/base/serial-number", "/proc/device-tree/serial-number", NULL };
  for (int i = 0; sp[i]; i++) {
    snprintf(p, sizeof p, "%s%s", root, sp[i]);
    if (read_line(p, v, sizeof v)) {
      char *s = v; while (*s == '0' && s[1]) s++;        /* "0000000012345678" and "12345678" are the same Pi */
      lower(s); used += snprintf(out + used, used < n ? n - used : 0, "serial %s\n", s);
      break;
    }
  }
  return used > 0;
}

static int hex2bin(const char *h, unsigned char *b, size_t n) {
  if (strlen(h) != 2 * n) return 0;
  for (size_t i = 0; i < n; i++) {
    unsigned x; if (sscanf(h + 2 * i, "%2x", &x) != 1) return 0;
    b[i] = (unsigned char)x;
  }
  return 1;
}

/* 1 = valid, 0 = no line for this machine, 2 = a line for this machine with a bad signature, -1 = no file */
static int check_file(const char *path, const char *ids, char *who, size_t n) {
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  char line[512]; int ok = 0;
  while (ok != 1 && fgets(line, sizeof line, f)) {
    char kind[16], id[160], sig[160];
    if (line[0] == '#' || sscanf(line, "%15s %159s %159s", kind, id, sig) != 3) continue;
    lower(kind); lower(id);
    if (strcmp(kind, "cid") && strcmp(kind, "serial")) continue;
    char want[200]; snprintf(want, sizeof want, "%s %s\n", kind, id);
    if (!strstr(ids, want)) continue;                       /* licence is for another card / Pi */
    unsigned char s[crypto_sign_BYTES];
    char msg[200]; int ml = snprintf(msg, sizeof msg, "fledgling-live/1 %s %s", kind, id);
    if (hex2bin(sig, s, sizeof s) &&
        crypto_sign_verify_detached(s, (const unsigned char *)msg, (unsigned long long)ml, LICENCE_PK) == 0) {
      ok = 1; size_t l = strlen(id); snprintf(who, n, "%s ...%s", !strcmp(kind, "cid") ? "card" : "pi", id + (l > 8 ? l - 8 : 0));
    } else ok = 2;
  }
  fclose(f);
  return ok;
}

int licence_check(const char *path, char *who, size_t n) {
  char ids[1024];
  snprintf(who, n, "no licence file");
  if (sodium_init() < 0) { snprintf(who, n, "crypto init failed"); return 0; }
  if (!licence_ids(ids, sizeof ids)) { snprintf(who, n, "no card or Pi id readable"); return 0; }
  if (ids_tampered()) { snprintf(who, n, "system ids are overridden"); return 0; }
  const char *one[] = { path, NULL };
  const char **files = path ? one : DEFAULT_FILES;
  for (int i = 0; files[i]; i++) {
    int r = check_file(files[i], ids, who, n);
    if (r == 1) return 1;
    if (r == 0) snprintf(who, n, "licence is for another card");
    if (r == 2) snprintf(who, n, "licence signature is not valid");
  }
  return 0;
}
