package position_test

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/lonhutt/dcx/pkg/position"
)

// mixed exercises all four width classes in one line.
//
//	byte:  0 1 2 3 4 5 6 7 8 9 10 11 12
//	       a   ' ' é(2)  ' ' 中(3)   ' ' 😀(4)
//
// The last row of the table below is the one that matters: at end of line the
// rune column is 7 but the UTF-16 column is 8, because the emoji is a surrogate
// pair. Any implementation that conflates the two passes every other row.
const mixed = "a é 中 😀"

func TestColumnsAtRuneBoundaries(t *testing.T) {
	ix := position.New([]byte(mixed))

	for _, tc := range []struct {
		off       int
		wantRune  int
		wantUTF16 int
		what      string
	}{
		{0, 0, 0, "start"},
		{1, 1, 1, "after 'a'"},
		{2, 2, 2, "start of é"},
		{4, 3, 3, "after é (2 bytes, 1 unit)"},
		{5, 4, 4, "start of 中"},
		{8, 5, 5, "after 中 (3 bytes, 1 unit)"},
		{9, 6, 6, "start of 😀"},
		{13, 7, 8, "after 😀 — 4 bytes, 1 rune, TWO utf-16 units"},
	} {
		gotLine, gotCol := ix.UTF8(position.Offset(tc.off))
		if gotLine != 0 || gotCol != tc.wantRune {
			t.Errorf("UTF8(%d) [%s] = (%d,%d), want (0,%d)",
				tc.off, tc.what, gotLine, gotCol, tc.wantRune)
		}

		gotLine, gotChar := ix.UTF16(position.Offset(tc.off))
		if gotLine != 0 || gotChar != tc.wantUTF16 {
			t.Errorf("UTF16(%d) [%s] = (%d,%d), want (0,%d)",
				tc.off, tc.what, gotLine, gotChar, tc.wantUTF16)
		}
	}
}

func TestLineStructure(t *testing.T) {
	for _, tc := range []struct {
		name      string
		src       string
		wantLines int
	}{
		{"empty is one line", "", 1},
		{"no trailing newline", "a\nb", 2},
		{"trailing newline adds an empty final line", "a\n", 2},
		{"two trailing newlines", "a\n\n", 3},
		{"crlf", "a\r\nb", 2},
		{"lone cr is a terminator", "a\rb", 2},
		{"mixed terminators", "a\r\nb\nc\rd", 4},
		{"only a newline", "\n", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ix := position.New([]byte(tc.src))
			if got := ix.LineCount(); got != tc.wantLines {
				t.Errorf("LineCount(%q) = %d, want %d", tc.src, got, tc.wantLines)
			}
			// EOF must always be addressable: every node's end offset can land there.
			if line, _ := ix.UTF16(position.Offset(len(tc.src))); line != tc.wantLines-1 {
				t.Errorf("UTF16(EOF) line = %d, want last line %d", line, tc.wantLines-1)
			}
		})
	}
}

// TestAgainstOracle is the acceptance criterion: for every rune boundary in the
// document, the real implementation must agree with the reference one, and the
// UTF-16 position must convert back to the byte offset it came from.
func TestAgainstOracle(t *testing.T) {
	for _, tc := range []struct{ name, src string }{
		{"empty", ""},
		{"ascii", "{\n  \"name\": \"x\"\n}\n"},
		{"latin1", "é\néé\n"},
		{"cjk", "中文\n中\n"},
		{"astral", "😀\n😀😀\n"},
		{"mixed", mixed},
		{"crlf", "a\r\nb\r\n"},
		{"lone cr", "a\rb\r"},
		{"emoji then ascii on same line", "😀abc\n"},
		{"invalid utf8", "a\xffb\n\xe4\n"},
		{"bom", "\ufeff{}\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checkAgainstOracle(t, []byte(tc.src))
		})
	}
}

// TestAgainstOracleLargeFixture runs the same comparison over a real 86 KB
// devcontainer.json with 1,885 non-ASCII characters and 9 astral-plane emoji
// spread across 1,558 lines. Hand-written cases prove the arithmetic; this
// proves it survives reality.
func TestAgainstOracleLargeFixture(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "large-commented.jsonc"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	checkAgainstOracle(t, src)
}

func checkAgainstOracle(t *testing.T, src []byte) {
	t.Helper()
	ix := position.New(src)
	orc := newOracle(src)

	// The line tables must agree before any per-offset comparison means much: a
	// differing line count means the two are indexing different documents, and
	// every column below would be checked against the wrong line.
	if got, want := ix.LineCount(), orc.lineCount(); got != want {
		t.Fatalf("LineCount() = %d, oracle says %d", got, want)
	}

	for _, off := range runeBoundaries(src) {
		wantLine, wantCol := orc.utf8At(off)
		gotLine, gotCol := ix.UTF8(position.Offset(off))
		if gotLine != wantLine || gotCol != wantCol {
			t.Fatalf("UTF8(%d) = (%d,%d), oracle says (%d,%d)\n%s",
				off, gotLine, gotCol, wantLine, wantCol, context(src, off))
		}

		// The UTF-8 direction round trips too: Design §5.2 specifies the arrow
		// both ways, for a terminal renderer that has a column and needs a span.
		if back := ix.OffsetUTF8(gotLine, gotCol); back != position.Offset(off) {
			t.Fatalf("OffsetUTF8(%d,%d) = %d, want %d (round trip)\n%s",
				gotLine, gotCol, back, off, context(src, off))
		}

		wantLine, wantChar := orc.utf16At(off)
		gotLine, gotChar := ix.UTF16(position.Offset(off))
		if gotLine != wantLine || gotChar != wantChar {
			t.Fatalf("UTF16(%d) = (%d,%d), oracle says (%d,%d)\n%s",
				off, gotLine, gotChar, wantLine, wantChar, context(src, off))
		}

		// Round trip. This is the half that DCL-55 depends on: didChange sends
		// UTF-16 ranges that must become byte offsets before text can be spliced.
		if back := ix.OffsetUTF16(gotLine, gotChar); back != position.Offset(off) {
			t.Fatalf("OffsetUTF16(%d,%d) = %d, want %d (round trip)\n%s",
				gotLine, gotChar, back, off, context(src, off))
		}
	}
}

// context renders the neighbourhood of a failing offset, because "want 41 got 42"
// is not enough to debug a column bug.
func context(src []byte, off int) string {
	lo, hi := off-20, off+20
	if lo < 0 {
		lo = 0
	}
	if hi > len(src) {
		hi = len(src)
	}
	var b strings.Builder
	b.WriteString("  context: ")
	b.WriteString(strconv.Quote(string(src[lo:off])))
	b.WriteString(" <HERE> ")
	b.WriteString(strconv.Quote(string(src[off:hi])))
	return b.String()
}

// TestLineRange pins the terminator semantics: a line's Range covers its visible
// text and stops before the terminator, so a diagnostic drawn over a whole line
// does not wrap the selection into the next one. Callers that want the
// terminator included ask for LineStart(line+1) instead.
//
// The cases that matter are CRLF (the terminator is two bytes, not one) and the
// empty lines, where backing up over a terminator must not run past the line
// start and produce an inverted range.
func TestLineRange(t *testing.T) {
	for _, tc := range []struct {
		name string
		src  string
		line int
		want string // the text the returned range must cover
	}{
		{"lf: first line", "a\nb", 0, "a"},
		{"lf: last line has no terminator", "a\nb", 1, "b"},
		{"crlf backs up two bytes", "a\r\nb", 0, "a"},
		{"crlf: second line", "a\r\nb", 1, "b"},
		{"lone cr is a terminator", "a\rb", 0, "a"},
		{"empty document is one empty line", "", 0, ""},
		{"trailing lf leaves an empty final line", "a\n", 1, ""},
		{"empty line between terminators", "a\n\nb", 1, ""},
		{"only a terminator", "\n", 0, ""},
		{"multi-byte runes: offsets are bytes", "中文\n", 0, "中文"},
		{"astral", "😀\n", 0, "😀"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ix := position.New([]byte(tc.src))
			r := ix.LineRange(tc.line)
			if r.Start > r.End {
				t.Fatalf("LineRange(%d) = %+v: start is past end", tc.line, r)
			}
			if got := tc.src[r.Start:r.End]; got != tc.want {
				t.Errorf("LineRange(%d) = %+v covering %q, want %q",
					tc.line, r, got, tc.want)
			}
		})
	}
}

// TestOffsetUTF16Clamps pins the LSP rule that a character past the end of a
// line defaults back to the line length, where "length" is the visible text and
// excludes the terminator.
//
// The scan used to be bounded by the end of the *document*, so an overlong
// character walked on into the following lines and returned an offset belonging
// to a line the caller never asked about. Clients are permitted to send exactly
// that, and incremental didChange (Design §9.2) turns the result straight into a
// splice point.
func TestOffsetUTF16Clamps(t *testing.T) {
	for _, tc := range []struct {
		name       string
		src        string
		line, char int
		want       position.Offset
	}{
		{"char past end of line stops at visible end", "a\nbbbb\n", 0, 3, 1},
		{"char far past end", "a\nbbbb\n", 0, 99, 1},
		{"char exactly at visible end", "a\nbbbb\n", 0, 1, 1},
		{"the terminator itself is not addressable", "a\nbbbb\n", 0, 2, 1},
		{"middle line clamps to its own end", "a\nbbbb\n", 1, 99, 6},
		{"last line without a terminator", "a\nb", 1, 99, 3},
		{"empty final line", "a\n", 1, 5, 2},
		{"crlf sheds both bytes", "a\r\nb", 0, 5, 1},
		{"astral: one rune is two units", "😀x\n", 0, 2, 4},
		{"astral: clamp past end", "😀x\n", 0, 99, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ix := position.New([]byte(tc.src))
			if got := ix.OffsetUTF16(tc.line, tc.char); got != tc.want {
				t.Errorf("OffsetUTF16(%d, %d) on %q = %d, want %d",
					tc.line, tc.char, tc.src, got, tc.want)
			}
		})
	}
}

// TestOffsetUTF8Clamps is TestOffsetUTF16Clamps' counterpart: a rune column past
// the end of a line resolves to that line's visible end, never into the next
// line's text.
func TestOffsetUTF8Clamps(t *testing.T) {
	for _, tc := range []struct {
		name      string
		src       string
		line, col int
		want      position.Offset
	}{
		{"col past end of line stops at visible end", "a\nbbbb\n", 0, 3, 1},
		{"col far past end", "a\nbbbb\n", 0, 99, 1},
		{"col exactly at visible end", "a\nbbbb\n", 0, 1, 1},
		{"middle line clamps to its own end", "a\nbbbb\n", 1, 99, 6},
		{"last line without a terminator", "a\nb", 1, 99, 3},
		{"empty final line", "a\n", 1, 5, 2},
		{"crlf sheds both bytes", "a\r\nb", 0, 5, 1},
		{"astral: one rune is one column", "😀x\n", 0, 1, 4},
		{"multi-byte: columns are runes, offsets are bytes", "中文\n", 0, 1, 3},
		{"negative col is the line start", "a\nbbbb\n", 1, -3, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ix := position.New([]byte(tc.src))
			if got := ix.OffsetUTF8(tc.line, tc.col); got != tc.want {
				t.Errorf("OffsetUTF8(%d, %d) on %q = %d, want %d",
					tc.line, tc.col, tc.src, got, tc.want)
			}
		})
	}
}

// TestOutOfRangeLinesClamp pins Design §4.2 invariant 1: nothing below cmd/
// panics. A didChange naming a line that a previous edit deleted is normal
// editor traffic, not malformed input.
//
// The policy is to clamp — line into [0, LineCount()) — matching what the two
// Offset* methods already do with an overlong column.
func TestOutOfRangeLinesClamp(t *testing.T) {
	const src = "a\nbb\n" // 3 lines: "a", "bb", ""
	ix := position.New([]byte(src))

	for _, tc := range []struct {
		name string
		call func() any
		want any
	}{
		{"LineStart negative", func() any { return ix.LineStart(-5) }, position.Offset(0)},
		{"LineStart past end", func() any { return ix.LineStart(99) }, position.Offset(5)},
		{"LineRange negative", func() any { return ix.LineRange(-5) }, position.Range{Start: 0, End: 1}},
		{"LineRange past end", func() any { return ix.LineRange(99) }, position.Range{Start: 5, End: 5}},
		{"Line negative offset", func() any { return ix.Line(-5) }, 0},
		{"Line offset past EOF", func() any { return ix.Line(99) }, 2},
		{"OffsetUTF16 negative line", func() any { return ix.OffsetUTF16(-5, 0) }, position.Offset(0)},
		{"OffsetUTF16 line past end", func() any { return ix.OffsetUTF16(99, 0) }, position.Offset(5)},
		{"OffsetUTF8 negative line", func() any { return ix.OffsetUTF8(-5, 0) }, position.Offset(0)},
		{"OffsetUTF8 line past end", func() any { return ix.OffsetUTF8(99, 0) }, position.Offset(5)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panicked: %v", r)
				}
			}()
			if got := tc.call(); got != tc.want {
				t.Errorf("= %v, want %v", got, tc.want)
			}
		})
	}
}

// TestOutOfRangeOffsetsClamp is the same invariant for the offset-taking
// conversions. A byte offset from a stale parse can outlive the edit that
// shortened the document.
func TestOutOfRangeOffsetsClamp(t *testing.T) {
	const src = "a\nbb\n"
	ix := position.New([]byte(src))

	for _, tc := range []struct {
		name              string
		off               position.Offset
		wantLine, wantCol int
	}{
		{"negative offset is the document start", -5, 0, 0},
		{"offset past EOF is the last line", 99, 2, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panicked: %v", r)
				}
			}()
			if l, c := ix.UTF8(tc.off); l != tc.wantLine || c != tc.wantCol {
				t.Errorf("UTF8(%d) = (%d,%d), want (%d,%d)", tc.off, l, c, tc.wantLine, tc.wantCol)
			}
			if l, c := ix.UTF16(tc.off); l != tc.wantLine || c != tc.wantCol {
				t.Errorf("UTF16(%d) = (%d,%d), want (%d,%d)", tc.off, l, c, tc.wantLine, tc.wantCol)
			}
		})
	}
}

// TestCRLFInteriorClamps covers the one offset class runeBoundaries deliberately
// does not enumerate: a position between the two bytes of a "\r\n" pair.
//
// It is a rune boundary, so a caller can hand it to UTF8 or UTF16, but it lies
// past the line's visible end. It therefore clamps there, and the column it
// yields converts back to that clamped offset — rather than to a column its own
// inverse would reject, which is what it did before.
//
// The oracle cannot check this: it measures columns over a raw line prefix and
// has no notion of clamping, which is exactly why it is simple enough to trust.
func TestCRLFInteriorClamps(t *testing.T) {
	for _, tc := range []struct {
		name              string
		src               string
		off               int
		wantLine          int
		wantCol, wantChar int // rune column, UTF-16 column
		wantBack          position.Offset
	}{
		{"between cr and lf", "a\r\nb", 2, 0, 1, 1, 1},
		{"crlf at the start of the document", "\r\nb", 1, 0, 0, 0, 0},
		{"crlf on a later line", "a\r\nbb\r\n", 6, 1, 2, 2, 5},
		{"multi-byte rune before the crlf", "中\r\n", 4, 0, 1, 1, 3},
		{"astral before the crlf: the two columns differ", "😀\r\n", 5, 0, 1, 2, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ix := position.New([]byte(tc.src))

			line, col := ix.UTF8(position.Offset(tc.off))
			if line != tc.wantLine || col != tc.wantCol {
				t.Errorf("UTF8(%d) on %q = (%d,%d), want (%d,%d)",
					tc.off, tc.src, line, col, tc.wantLine, tc.wantCol)
			}
			if back := ix.OffsetUTF8(line, col); back != tc.wantBack {
				t.Errorf("OffsetUTF8(%d,%d) = %d, want %d", line, col, back, tc.wantBack)
			}

			line, char := ix.UTF16(position.Offset(tc.off))
			if line != tc.wantLine || char != tc.wantChar {
				t.Errorf("UTF16(%d) on %q = (%d,%d), want (%d,%d)",
					tc.off, tc.src, line, char, tc.wantLine, tc.wantChar)
			}
			if back := ix.OffsetUTF16(line, char); back != tc.wantBack {
				t.Errorf("OffsetUTF16(%d,%d) = %d, want %d", line, char, back, tc.wantBack)
			}
		})
	}
}
