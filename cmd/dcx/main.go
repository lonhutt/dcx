// Command dcx is a static analyser and language server for dev container
// configuration.
//
// It ships as a single binary with subcommands rather than separate tools, so
// the CLI, the language server, and the editor extension all share one
// distribution artefact:
//
//	dcx check [path...]     analyse devcontainer.json
//	dcx serve --stdio       run the language server
//	dcx explain <rule-id>   describe a rule
//	dcx feature <path>      analyse devcontainer-feature.json
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

const usage = `dcx — static analysis for dev container configuration

Usage:
  dcx <command> [flags] [path...]

Commands:
  check      Analyse devcontainer.json (default when a path is given)
  serve      Run the language server over stdio
  explain    Print the long-form description of a rule
  feature    Analyse devcontainer-feature.json
  version    Print version information

Run "dcx <command> --help" for command-specific flags.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

// run holds all the logic so main stays a single call. Nothing below cmd/ is
// permitted to call os.Exit; keeping that boundary here from the start is what
// lets the language server reuse the same code paths.
func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return exitToolErr
	}

	switch args[0] {
	case "version", "--version", "-v":
		fmt.Printf("dcx %s (%s, built %s)\n", version, commit, date)
		return exitClean
	case "help", "--help", "-h":
		fmt.Print(usage)
		return exitClean
	case "check", "serve", "explain", "feature":
		fmt.Fprintf(os.Stderr, "dcx: %s is not implemented yet (skeleton)\n", args[0])
		return exitToolErr
	default:
		fmt.Fprintf(os.Stderr, "dcx: unknown command %q\n\n%s", args[0], usage)
		return exitToolErr
	}
}
