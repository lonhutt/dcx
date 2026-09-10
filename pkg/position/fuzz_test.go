package position_test

import (
	"testing"

	"github.com/lonhutt/dcx/pkg/position"
)

// FuzzLineIndex asserts the two properties that must hold for arbitrary bytes:
// nothing panics, and every result stays in bounds and round trips.
//
// Malformed UTF-8 is a normal input for a linter, not an exotic one. The oracle
// and the implementation agree on it as long as both advance one byte per
// invalid byte, which is what utf8.DecodeRune does when it returns RuneError.
func FuzzLineIndex(f *testing.F) {
	for _, seed := range []string{
		"",
		"{}",
		"a\n",
		"a\r\nb\rc",
		mixed,
		"😀\n中\né",
		"a\xffb",     // invalid byte
		"\xe4",       // truncated multi-byte sequence
		"\ufeff{}\n", // BOM
	} {
		f.Add([]byte(seed))
	}

	f.Fuzz(func(t *testing.T, src []byte) {
		ix := position.New(src)
		orc := newOracle(src)

		if n := ix.LineCount(); n < 1 {
			t.Fatalf("LineCount() = %d, must be at least 1 even for empty input", n)
		}
		if got, want := ix.LineCount(), orc.lineCount(); got != want {
			t.Fatalf("LineCount() = %d, oracle says %d", got, want)
		}

		for _, off := range runeBoundaries(src) {
			// Checked against the oracle as well as through its own inverse: a
			// defect shared by UTF8 and OffsetUTF8 satisfies the round trip while
			// still producing the wrong column.
			wantLine, wantCol := orc.utf8At(off)
			l, c := ix.UTF8(position.Offset(off))
			if l != wantLine || c != wantCol {
				t.Fatalf("UTF8(%d) = (%d,%d), oracle says (%d,%d)", off, l, c, wantLine, wantCol)
			}
			if back := ix.OffsetUTF8(l, c); back != position.Offset(off) {
				t.Fatalf("utf8 round trip: offset %d -> (%d,%d) -> %d", off, l, c, back)
			}

			line, char := ix.UTF16(position.Offset(off))
			if line < 0 || line >= ix.LineCount() {
				t.Fatalf("UTF16(%d) line = %d, out of range [0,%d)", off, line, ix.LineCount())
			}
			if char < 0 {
				t.Fatalf("UTF16(%d) char = %d, negative", off, char)
			}

			if back := ix.OffsetUTF16(line, char); back != position.Offset(off) {
				t.Fatalf("round trip: offset %d -> (%d,%d) -> %d", off, line, char, back)
			}

			// Agreement with the reference implementation must hold here too,
			// not just on the curated corpus.
			if wl, wc := orc.utf16At(off); wl != line || wc != char {
				t.Fatalf("UTF16(%d) = (%d,%d), oracle says (%d,%d)", off, line, char, wl, wc)
			}
		}
	})
}
