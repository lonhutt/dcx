package position_test

import (
	"unicode/utf16"
	"unicode/utf8"
)

// This file is the reference implementation the real one is tested against.
//
// The per-offset arithmetic here is deliberately the slowest, most obviously
// correct code that could work: it re-encodes the line prefix through []rune and
// utf16.Encode on every call, because that is the *definition* of an LSP column
// rather than an optimisation of it. Nothing in that path should ever be made
// clever. Its only job is to be so simple that when it disagrees with
// pkg/position, the bug is in pkg/position.
//
// The one concession is that line splitting is hoisted into newOracle instead of
// being redone per call. That is not cleverness, it is the difference between a
// 0.3s test and a 30s one on the 86 KB fixture: splitting is O(n) and was being
// run once per offset, making the whole check O(n^2).

type oracle struct {
	src    []byte
	starts []int // byte offset at which each line begins
}

// newOracle splits src into lines, treating "\n", "\r\n" and a lone "\r" as
// terminators — which is what VS Code and other LSP clients do. If this
// disagrees with the real implementation, every position after the first stray
// carriage return is silently wrong.
func newOracle(src []byte) *oracle {
	starts := []int{0}
	for i := 0; i < len(src); {
		switch src[i] {
		case '\n':
			i++
			starts = append(starts, i)
		case '\r':
			i++
			if i < len(src) && src[i] == '\n' {
				i++
			}
			starts = append(starts, i)
		default:
			i++
		}
	}
	// A source ending in a terminator has a final, empty line whose start offset
	// equals len(src). That line is addressable and must not be dropped.
	return &oracle{src: src, starts: starts}
}

func (o *oracle) lineCount() int { return len(o.starts) }

// line returns the 0-based line containing off.
func (o *oracle) line(off int) int {
	line := 0
	for i, s := range o.starts {
		if s > off {
			break
		}
		line = i
	}
	return line
}

// utf8At returns the 0-based line and the column measured in runes.
func (o *oracle) utf8At(off int) (line, col int) {
	line = o.line(off)
	return line, utf8.RuneCount(o.src[o.starts[line]:off])
}

// utf16At returns the 0-based line and the column measured in UTF-16 code units,
// which is what the Language Server Protocol means by Position.character.
//
// Invalid UTF-8 becomes one U+FFFD per bad byte here, which is also how
// utf8.DecodeRune advances, so the two agree even on malformed input.
func (o *oracle) utf16At(off int) (line, char int) {
	line = o.line(off)
	return line, len(utf16.Encode([]rune(string(o.src[o.starts[line]:off]))))
}

// runeBoundaries returns every offset in [0, len(src)] that names a position.
//
// Offsets inside a multi-byte rune have no meaningful column and cannot round
// trip, so tests must not assert on them. The interior of a "\r\n" pair is
// excluded for the same reason: the terminator is one unit of line structure,
// and LSP columns are measured over a line's visible text, which stops before
// it. An offset between the two bytes therefore names no column at all.
func runeBoundaries(src []byte) []int {
	offs := make([]int, 0, len(src)+1)
	for i := 0; i < len(src); {
		if src[i] == '\n' && i > 0 && src[i-1] == '\r' {
			i++
			continue
		}
		offs = append(offs, i)
		// Advance by what DecodeRune consumes, not by one byte with a RuneStart
		// filter. The two agree on valid UTF-8, but inside a truncated sequence
		// DecodeRune yields a one-byte RuneError per continuation byte, and those
		// offsets are reachable positions the filter would skip.
		_, size := utf8.DecodeRune(src[i:])
		i += size
	}
	return append(offs, len(src)) // EOF is always a valid position
}
