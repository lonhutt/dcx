package position_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/lonhutt/dcx/pkg/position"
)

// These exist to answer one question if it is ever raised: is the column scan
// worth optimising? Measured first, optimised only if the numbers say so.
//
// For scale: the worst line in the 86 KB fixture is 186 characters, so the scan
// from line start to offset is bounded by that regardless of file size.

func BenchmarkNew(b *testing.B) {
	src := loadFixture(b)
	b.ReportAllocs()
	b.SetBytes(int64(len(src)))
	for b.Loop() {
		_ = position.New(src)
	}
}

func BenchmarkUTF16(b *testing.B) {
	src := loadFixture(b)
	ix := position.New(src)
	off := position.Offset(len(src) / 2)
	b.ReportAllocs()
	for b.Loop() {
		_, _ = ix.UTF16(off)
	}
}

func loadFixture(tb testing.TB) []byte {
	tb.Helper()
	src, err := os.ReadFile(filepath.Join("testdata", "large-commented.jsonc"))
	if err != nil {
		tb.Fatalf("read fixture: %v", err)
	}
	return src
}
