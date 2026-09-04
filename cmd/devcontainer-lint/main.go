// Command devcontainer-lint is a static analyser for devcontainer.json files.
package main

import (
	"fmt"
	"os"
)

// Build metadata, overridden at release time via -ldflags.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

// Exit codes are a compatibility contract: 0 clean, 1 lint findings at or above
// the failure threshold, 2 a tool error. CI relies on telling 1 from 2.
const (
	exitClean    = 0
	exitFindings = 1
	exitToolErr  = 2
)

func main() {
	os.Exit(run(os.Args[1:]))
}

// run holds all the logic so main stays a single call. Nothing below cmd/ is
// permitted to call os.Exit; keeping that boundary here from the start is what
// lets the language server reuse the same code paths.
func run(args []string) int {
	if len(args) > 0 && args[0] == "--version" {
		fmt.Printf("devcontainer-lint %s (%s, built %s)\n", version, commit, date)
		return exitClean
	}
	fmt.Fprintln(os.Stderr, "devcontainer-lint: not implemented yet (skeleton)")
	return exitToolErr
}
