package position

import (
	"slices"
	"unicode/utf16"
	"unicode/utf8"
)

// Offset is a byte offset into a document. It is the single coordinate the rest
// of dcx passes around; line/column pairs exist only at the edges, where a
// terminal or an LSP client demands them.
type Offset int

// Range is a half-open byte span, [Start, End). Start equal to End is an empty
// range that still points somewhere meaningful — the caret position for an
// insertion, for instance.
type Range struct {
	Start, End Offset
}

// LineIndex maps byte offsets to line/column pairs for one document. Build it
// once per document with New.
//
// It retains src rather than copying it, so src must not be mutated while the
// index is in use.
type LineIndex struct {
	src        []byte
	lineStarts []int // byte offset at which each line begins
}

// New indexes src by line, treating "\n", "\r\n" and a lone "\r" as terminators,
// which is what VS Code and other LSP clients do.
//
// A document ending in a terminator has a final, empty line whose start offset
// equals len(src). The line count is therefore always at least one, and EOF is
// always an addressable position — every node's end offset can land there.
func New(src []byte) *LineIndex {
	lineStarts := []int{0}
	for i := 0; i < len(src); {
		switch src[i] {
		case '\n':
			i++
			lineStarts = append(lineStarts, i)
		case '\r':
			i++
			if i < len(src) && src[i] == '\n' {
				i++ // consume the \n of a \r\n pair
			}
			lineStarts = append(lineStarts, i)
		default:
			i++
		}
	}
	return &LineIndex{src: src, lineStarts: lineStarts}
}

// clampLine constrains line to one that exists. Design §4.2 invariant 1 forbids
// panicking below cmd/, and an editor naming a line a previous edit deleted is
// routine traffic rather than a programming error.
func (ix *LineIndex) clampLine(line int) int {
	if line < 0 {
		return 0
	}
	if line >= len(ix.lineStarts) {
		return len(ix.lineStarts) - 1
	}
	return line
}

// clampOffset constrains off to [0, len(src)]. The upper bound is inclusive
// because EOF is an addressable position.
func (ix *LineIndex) clampOffset(off Offset) int {
	if off < 0 {
		return 0
	}
	if int(off) > len(ix.src) {
		return len(ix.src)
	}
	return int(off)
}

// LineCount returns the number of lines, which is at least 1 even for an empty
// document.
func (ix *LineIndex) LineCount() int { return len(ix.lineStarts) }

// LineStart returns the byte offset at which line begins.
//
// line is clamped to a line that exists, so an out-of-range value returns the
// first or last line's start rather than panicking.
func (ix *LineIndex) LineStart(line int) Offset {
	return Offset(ix.lineStarts[ix.clampLine(line)])
}

// Line returns the 0-based line containing off, in O(log lines).
//
// BinarySearch reports the index at which off would be inserted. A hit means off
// is exactly a line start; a miss means off falls inside the preceding line,
// hence i-1. off is clamped to [0, len(src)] first, so a stale offset from
// before an edit resolves to the first or last line instead of panicking.
func (ix *LineIndex) Line(off Offset) int {
	i, found := slices.BinarySearch(ix.lineStarts, ix.clampOffset(off))
	if found {
		return i
	}
	return i - 1
}

// LineRange returns the byte range of line, excluding its terminator, so a
// diagnostic drawn over a whole line does not wrap into the next one. Callers
// that want the terminator included use LineStart(line+1) as the end.
//
// line is clamped to a line that exists.
func (ix *LineIndex) LineRange(line int) Range {
	line = ix.clampLine(line)
	start := ix.lineStarts[line]

	// The last line runs to EOF; every other line runs to the next line's start,
	// which sits just past that line's terminator.
	end := len(ix.src)
	if line+1 < len(ix.lineStarts) {
		end = ix.lineStarts[line+1]
	}

	// Back up over the terminator. These are two sequential ifs rather than an
	// else-if because "\r\n" has to shed both bytes. The end > start guard keeps
	// an empty line from backing up past its own start into an inverted range.
	if end > start && ix.src[end-1] == '\n' {
		end--
	}
	if end > start && ix.src[end-1] == '\r' {
		end--
	}

	return Range{Start: Offset(start), End: Offset(end)}
}

// UTF8 returns the 0-based line containing off and the column measured in runes,
// which is what a terminal renderer needs to place a caret under the right
// character.
//
// Invalid UTF-8 counts one rune per bad byte, matching how utf8.DecodeRune
// advances, so columns stay consistent on malformed input.
//
// An offset past the line's visible end — the interior of a "\r\n" pair is the
// only way to reach one — clamps to that end, so the column always converts back
// through OffsetUTF8 to the offset this returned it for.
func (ix *LineIndex) UTF8(off Offset) (line, col int) {
	o := ix.clampOffset(off)
	line = ix.Line(Offset(o))
	o = min(o, int(ix.LineRange(line).End))
	return line, utf8.RuneCount(ix.src[ix.lineStarts[line]:o])
}

// UTF16 returns the 0-based line containing off and the column measured in
// UTF-16 code units, which is what the Language Server Protocol means by
// Position.character.
//
// The difference from UTF8 is not cosmetic: an astral-plane character such as an
// emoji is one rune but two code units, so the two columns diverge after it.
//
// As with UTF8, an offset inside a "\r\n" pair clamps to the line's visible end,
// keeping the column within what OffsetUTF16 will accept.
//
// Ranging over string(...) here does not allocate. The compiler special-cases a
// []byte-to-string conversion used directly as a range expression; assigning it
// to a variable first would cost a copy.
func (ix *LineIndex) UTF16(off Offset) (line, char int) {
	o := ix.clampOffset(off)
	line = ix.Line(Offset(o))
	o = min(o, int(ix.LineRange(line).End))
	for _, r := range string(ix.src[ix.lineStarts[line]:o]) {
		char += utf16.RuneLen(r)
	}
	return line, char
}

// OffsetUTF8 converts a (line, rune column) pair back into a byte offset. It is
// the inverse of UTF8, completing the arrow Design §5.2 specifies in both
// directions.
//
// As with OffsetUTF16, a col past the end of the line clamps to that line's
// visible end, so the returned offset always belongs to the line asked for.
func (ix *LineIndex) OffsetUTF8(line, col int) Offset {
	lr := ix.LineRange(line)
	i, end := int(lr.Start), int(lr.End)
	for col > 0 && i < end {
		_, size := utf8.DecodeRune(ix.src[i:end])
		i += size
		col--
	}
	return Offset(i)
}

// OffsetUTF16 converts an LSP position back into a byte offset. It is the
// inverse of UTF16, and the half DCL-55 depends on: didChange delivers UTF-16
// ranges that must become offsets before text can be spliced.
//
// A char landing inside a surrogate pair resolves to the offset just past the
// character containing it.
//
// A char past the end of the line clamps to that line's visible end, per the LSP
// rule that an overlong character defaults back to the line length. The scan is
// bounded by LineRange rather than by the document, so the returned offset always
// belongs to the line that was asked for.
func (ix *LineIndex) OffsetUTF16(line, char int) Offset {
	lr := ix.LineRange(line)
	i, end := int(lr.Start), int(lr.End)
	for char > 0 && i < end {
		r, size := utf8.DecodeRune(ix.src[i:end])
		i += size
		char -= utf16.RuneLen(r)
	}
	return Offset(i)
}
