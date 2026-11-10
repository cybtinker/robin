#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#define M_PI 3.14159265358979323846
#define IMPORT(n) __attribute__((import_module("env"), import_name(#n)))
// sin/cos computed inside wasm (no JS call per sample): Cody-Waite reduction + minimax kernels
static inline double __ksin(double x){double z=x*x;return x+x*z*(-1.66666666666666324348e-01+z*(8.33333333332248946124e-03+z*(-1.98412698298579493134e-04+z*(2.75573137070700676789e-06+z*(-2.50507602534068634195e-08+z*1.58969099521155010221e-10)))));}
static inline double __kcos(double x){double z=x*x;return 1.0-0.5*z+z*z*(4.16666666666666019037e-02+z*(-1.38888888888741095749e-03+z*(2.48015872894767294178e-05+z*(-2.75573143513906633035e-07+z*(2.08757232129817482790e-09+z*-1.13596475577881948265e-11)))));}
static inline double __sc(double x,int c){ /* c=0 sin, c=1 cos */
  double k=__builtin_rint(x*6.36619772367581382433e-01);
  double r=((x-k*1.57079632673412561417e+00)-k*6.07710050650619224932e-11)-k*2.02226624879595063154e-21;
  long long q=(long long)k+c; q&=3;
  double v=(q&1)?__kcos(r):__ksin(r); return (q&2)?-v:v; }
static inline double sin(double x){return __sc(x,0);} static inline double cos(double x){return __sc(x,1);}
IMPORT(exp) double exp(double); IMPORT(log) double log(double);
IMPORT(log10) double log10(double); IMPORT(pow) double pow(double,double);
IMPORT(atan) double atan(double); IMPORT(fmod) double fmod(double,double);
static inline double sqrt(double x){return __builtin_sqrt(x);}
static inline double fabs(double x){return __builtin_fabs(x);}
static inline double floor(double x){return __builtin_floor(x);}
static inline double ceil(double x){return __builtin_ceil(x);}
#ifdef __cplusplus
}
#endif
