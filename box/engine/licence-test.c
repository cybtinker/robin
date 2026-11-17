/* Test harness: licence-test FILE  (reads ids from $FLEDGLING_SYSROOT). Exit 0 = licensed. */
#include "licence.h"
#include <stdio.h>
int main(int argc, char **argv) {
  char who[64];
  int ok = licence_check(argc > 1 ? argv[1] : NULL, who, sizeof who);
  printf("%s (%s)\n", ok ? "LICENSED" : "not licensed", who);
  return ok ? 0 : 2;
}
