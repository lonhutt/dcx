// Package devcontainerlint documents the public API surface of devcontainer-lint.
//
// Everything under pkg/ is public, semver-stable API. Rule IDs, the Diagnostic
// shape, and the exported signatures of these packages are a compatibility
// contract: they may gain additions in a minor release, but they do not change
// meaning or disappear outside a major release. Code under cmd/ is not part of
// that contract.
//
// This package contains no code. It exists to state the guarantee in one place
// that godoc will surface.
//
// The layering is:
//
//	jsonc     -> parse source into a concrete syntax tree with byte-exact spans
//	model     -> lower that tree into a typed model and pick the scenario
//	schema    -> validate, and translate validator output into readable prose
//	rules     -> run the rule registry over the document
//	report    -> render the resulting diagnostics
//
// with position, vfs, and diagnostic as the shared vocabulary beneath all of it.
package devcontainerlint
