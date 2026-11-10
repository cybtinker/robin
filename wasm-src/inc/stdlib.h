#pragma once
typedef __SIZE_TYPE__ size_t;
#ifdef __cplusplus
extern "C" {
#endif
void* malloc(size_t); void free(void*);
static inline int abs(int x){return x<0?-x:x;}
#ifdef __cplusplus
}
#endif
#ifndef NULL
#define NULL 0
#endif
