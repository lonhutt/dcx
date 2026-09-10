BINARY := dcx
PKG    := github.com/lonhutt/dcx

# Windows has no Unix `date`, and GNU make dispatches $(shell) through cmd.exe
# there, so guard the shell-dependent defaults. CI passes these in explicitly.
ifeq ($(OS),Windows_NT)
  EXT  := .exe
  DATE ?= unknown
else
  EXT  :=
  DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
endif

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)

# Race is the local default. CI clears it on the legs where it is not wanted:
# it needs cgo and a C toolchain, and adds nothing outside linux/amd64.
TESTFLAGS ?= -race

LDFLAGS := -s -w \
	-X main.version=$(VERSION) \
	-X main.commit=$(COMMIT) \
	-X main.date=$(DATE)

.DEFAULT_GOAL := check

.PHONY: build
build: ## Build the CLI into ./bin
	go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)$(EXT) ./cmd/$(BINARY)

.PHONY: test
test: ## Run tests (TESTFLAGS=-race by default)
	go test $(TESTFLAGS) ./...

.PHONY: cover
cover: ## Run tests and write a coverage profile
	go test $(TESTFLAGS) -coverprofile=coverage.out -covermode=atomic ./...
	go tool cover -func=coverage.out | tail -1

.PHONY: vet
vet: ## Run go vet
	go vet ./...

.PHONY: lint
lint: ## Run golangci-lint
	golangci-lint run

.PHONY: fmt
fmt: ## Format the tree
	gofmt -w .

.PHONY: fmt-check
fmt-check: ## Fail if anything is unformatted
	@out=$$(gofmt -l .); if [ -n "$$out" ]; then echo "unformatted:"; echo "$$out"; exit 1; fi

# Go fuzzes one target per invocation, so discover them rather than naming one:
# a hardcoded target silently passes once the package it names moves or is not
# written yet. Exits non-zero if it finds nothing, for the same reason.
FUZZTIME ?= 30s

.PHONY: fuzz
fuzz: ## Bounded fuzz run over every Fuzz target (FUZZTIME=30s)
	@set -e; \
	found=0; \
	for pkg in $$(go list ./...); do \
		for fn in $$(go test -list='Fuzz.*' $$pkg 2>/dev/null | grep '^Fuzz' || true); do \
			found=1; \
			echo "==> $$pkg $$fn ($(FUZZTIME))"; \
			go test -run='^$$' -fuzz="^$$fn$$" -fuzztime=$(FUZZTIME) $$pkg; \
		done; \
	done; \
	if [ $$found -eq 0 ]; then echo "no fuzz targets found"; exit 1; fi

.PHONY: check
check: fmt-check vet lint test ## Everything CI runs

.PHONY: clean
clean:
	rm -rf bin dist coverage.out

.PHONY: help
help: ## List targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
