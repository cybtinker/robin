/* Fledgling Live licence: the app is locked to the SD card it was sold on (or to one Pi).
 * See box/licence/README.md. */
#ifndef FLEDGLING_LICENCE_H
#define FLEDGLING_LICENCE_H
#include <stddef.h>

/* Checks the licence file against this machine. Returns 1 when valid. `who` gets a short
 * description ("card 0353...", "pi 1000...", or why it failed). `path` NULL = the default places. */
int licence_check(const char *path, char *who, size_t n);

/* For tests: the ids this machine would accept, one per line ("cid <hex>", "serial <hex>"). */
int licence_ids(char *out, size_t n);
#endif
