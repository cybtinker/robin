#include <stdlib.h>
#include "world/harvest.h"
#include "world/cheaptrick.h"
#include "world/d4c.h"
#include "world/synthesis.h"
#define EXPORT(n) extern "C" __attribute__((export_name(#n)))
EXPORT(walloc) void* walloc(int n){return malloc(n);}
EXPORT(wfree) void wfree(void*p){free(p);}
EXPORT(harvest_len) int harvest_len(int fs,int n,double fp){return GetSamplesForHarvest(fs,n,fp);}
EXPORT(harvest) void harvest(const double*x,int n,int fs,double f0lo,double f0hi,double fp,double*t,double*f0){
  HarvestOption o; InitializeHarvestOption(&o); o.f0_floor=f0lo; o.f0_ceil=f0hi; o.frame_period=fp; Harvest(x,n,fs,&o,t,f0);}
EXPORT(ct_fft_size) int ct_fft_size(int fs,double f0lo){CheapTrickOption o; InitializeCheapTrickOption(fs,&o); o.f0_floor=f0lo; return GetFFTSizeForCheapTrick(fs,&o);}
static double** rows(double*flat,int nf,int nb){double**r=(double**)malloc(sizeof(double*)*nf);for(int i=0;i<nf;i++)r[i]=flat+(size_t)i*nb;return r;}
EXPORT(cheaptrick) void cheaptrick(const double*x,int n,int fs,const double*t,const double*f0,int nf,int fft,double*sp){
  CheapTrickOption o; InitializeCheapTrickOption(fs,&o); o.fft_size=fft; o.q1=-0.15; double**r=rows(sp,nf,fft/2+1); CheapTrick(x,n,fs,t,f0,nf,&o,r); free(r);}
EXPORT(d4c) void d4c(const double*x,int n,int fs,const double*t,const double*f0,int nf,int fft,double thr,double*ap){
  D4COption o; InitializeD4COption(&o); o.threshold=thr; double**r=rows(ap,nf,fft/2+1); D4C(x,n,fs,t,f0,nf,fft,&o,r); free(r);}
EXPORT(synth) void synth(const double*f0,int nf,double*sp,double*ap,int fft,double fp,int fs,int ylen,double*y){
  double**a=rows(sp,nf,fft/2+1);double**b=rows(ap,nf,fft/2+1); Synthesis(f0,nf,a,b,fft,fp,fs,ylen,y); free(a);free(b);}
