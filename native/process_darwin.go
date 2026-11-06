//go:build darwin

package main

/*
#include <libproc.h>
*/
import "C"
import "unsafe"

// proc_pidpath queries the kernel executable, independent of argv.
func processImage(pid uint32) string {
	if pid == 0 {
		return ""
	}
	b := make([]byte, C.PROC_PIDPATHINFO_MAXSIZE)
	n := C.proc_pidpath(C.int(pid), unsafe.Pointer(&b[0]), C.uint32_t(len(b)))
	if n <= 0 {
		return ""
	}
	return C.GoString((*C.char)(unsafe.Pointer(&b[0])))
}
