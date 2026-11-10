// Tiny runtime for WORLD on bare wasm32: size-class allocator + new/delete.
typedef __SIZE_TYPE__ size_t;
extern unsigned char __heap_base;
static size_t brk_ = 0;
static void* freelist[48];
static void* grow(size_t n){
  if(!brk_) brk_=((size_t)&__heap_base+15)&~(size_t)15;
  size_t end=brk_+n, have=__builtin_wasm_memory_size(0)*65536;
  if(end>have){ size_t pages=(end-have+65535)/65536; if(__builtin_wasm_memory_grow(0,pages)==(size_t)-1) return 0; }
  void* p=(void*)brk_; brk_=end; return p;
}
extern "C" void* malloc(size_t n){
  int c=4; while(((size_t)1<<c) < n+16) c++;
  void* p;
  if(freelist[c]){ p=freelist[c]; freelist[c]=*(void**)p; }
  else { p=grow((size_t)1<<c); if(!p) __builtin_trap(); *(int*)p=c; p=(char*)p+16; }
  return p;
}
extern "C" void free(void* p){ if(!p) return; int c=*(int*)((char*)p-16); *(void**)p=freelist[c]; freelist[c]=p; }
void* operator new(size_t n){return malloc(n);} void* operator new[](size_t n){return malloc(n);}
void operator delete(void*p) noexcept{free(p);} void operator delete[](void*p) noexcept{free(p);}
void operator delete(void*p,size_t) noexcept{free(p);} void operator delete[](void*p,size_t) noexcept{free(p);}
extern "C" void* memset(void* d,int c,size_t n){volatile unsigned char*p=(volatile unsigned char*)d;while(n--)*p++=(unsigned char)c;return d;}
extern "C" void* memcpy(void* d,const void* s,size_t n){volatile unsigned char*p=(volatile unsigned char*)d;const unsigned char*q=(const unsigned char*)s;while(n--)*p++=*q++;return d;}
