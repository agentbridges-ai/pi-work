/*
 * Bun FFI cannot directly describe C varargs. Keep this wrapper deliberately
 * tiny: it gives openat(2)'s optional mode a fixed ABI while the TypeScript
 * layer still loads the remaining primitives from the fixed system libc.
 */
#if defined(__APPLE__)
typedef unsigned short piwork_mode_t;
#else
typedef unsigned int piwork_mode_t;
#endif

typedef int (*piwork_openat_fn)(int, const char *, int, ...);
extern void *dlopen(const char *, int);
extern void *dlsym(void *, const char *);

#if defined(__APPLE__)
#define PIWORK_LIBC_PATH "/usr/lib/libSystem.B.dylib"
#elif defined(__x86_64__)
#define PIWORK_LIBC_PATH "/lib/x86_64-linux-gnu/libc.so.6"
#elif defined(__aarch64__)
#define PIWORK_LIBC_PATH "/lib/aarch64-linux-gnu/libc.so.6"
#else
#define PIWORK_LIBC_PATH ""
#endif

static piwork_openat_fn piwork_fixed_openat(void) {
  static piwork_openat_fn function = 0;
  if (function) return function;
  void *library = dlopen(PIWORK_LIBC_PATH, 2 /* RTLD_NOW */);
  if (!library) return 0;
  function = (piwork_openat_fn)dlsym(library, "openat");
  return function;
}

int piwork_openat4(
    int dirfd,
    const char *path,
    int flags,
    unsigned int mode) {
  piwork_openat_fn function = piwork_fixed_openat();
  if (!function) return -1;
  return function(dirfd, path, flags, (piwork_mode_t)mode);
}
