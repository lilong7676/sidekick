APP       := Sidekick
BIN       := SidekickBar
BUILDDIR  := .build/release
BUNDLE    := build/$(APP).app
INSTALLED := /Applications/$(APP).app
ROOT      := ..
BUN       ?= $(shell command -v bun 2>/dev/null || echo $(HOME)/.bun/bin/bun)
# package.json is the one place the version lives; the app's Info.plist and the release zip take it from there.
VERSION   := $(shell plutil -extract version raw -o - $(ROOT)/package.json)
ZIP       := build/$(APP)-v$(VERSION).zip

.PHONY: all build daemon icon bundle zip install uninstall run run-local stop clean

all: bundle

build:
	swift build -c release

# The daemon and the pinned slackcli, each compiled into a single file that carries its own runtime:
# the machine running Sidekick.app needs neither bun nor this checkout.
daemon:
	cd $(ROOT) && $(BUN) install --frozen-lockfile
	cd $(ROOT) && $(BUN) build --compile src/cli.ts --outfile app/build/bin/sidekick
	cd $(ROOT) && $(BUN) build --compile node_modules/slackcli/src/index.ts --outfile app/build/slackcli/slackcli

# Resources/AppIcon.icns is committed. After editing Resources/AppIcon.svg, run make icon and commit both.
icon:
	rm -rf build/AppIcon.iconset
	swift scripts/render-icon.swift Resources/AppIcon.svg build/AppIcon.iconset
	iconutil -c icns build/AppIcon.iconset -o Resources/AppIcon.icns

# Hand-assembled .app, ad-hoc signed (no developer identity on this machine):
#   Contents/MacOS/SidekickBar                         the menu bar app
#   Contents/Resources/AppIcon.icns                    Finder, notifications, Login Items
#   Contents/Resources/bin/sidekick                    daemon + CLI
#   Contents/Resources/slackcli/slackcli               on the agent's PATH; sidekick itself is not
# On launch the app writes ~/Library/LaunchAgents/local.sidekick.daemon.plist pointing at its daemon and loads it.
bundle: build daemon
	rm -rf "$(BUNDLE)"
	mkdir -p "$(BUNDLE)/Contents/MacOS" "$(BUNDLE)/Contents/Resources/bin" "$(BUNDLE)/Contents/Resources/slackcli"
	cp Resources/Info.plist "$(BUNDLE)/Contents/Info.plist"
	plutil -replace CFBundleShortVersionString -string "$(VERSION)" "$(BUNDLE)/Contents/Info.plist"
	plutil -replace CFBundleVersion -string "$(VERSION)" "$(BUNDLE)/Contents/Info.plist"
	cp "$(BUILDDIR)/$(BIN)" "$(BUNDLE)/Contents/MacOS/$(BIN)"
	cp Resources/AppIcon.icns "$(BUNDLE)/Contents/Resources/AppIcon.icns"
	cp build/bin/sidekick "$(BUNDLE)/Contents/Resources/bin/sidekick"
	cp build/slackcli/slackcli "$(BUNDLE)/Contents/Resources/slackcli/slackcli"
	codesign --force --sign - "$(BUNDLE)/Contents/Resources/bin/sidekick" "$(BUNDLE)/Contents/Resources/slackcli/slackcli"
	codesign --force --sign - --identifier local.sidekick.bar "$(BUNDLE)"
	@echo "built $(BUNDLE)"

# What goes on GitHub Releases (.github/workflows/release.yml), with its checksum.
zip: bundle
	rm -f build/$(APP)-v*.zip build/$(APP)-v*.zip.sha256
	ditto -c -k --keepParent "$(BUNDLE)" "$(ZIP)"
	cd build && shasum -a 256 "$(notdir $(ZIP))" > "$(notdir $(ZIP)).sha256"
	@echo "built $(ZIP)"

install: bundle stop
	rm -rf "$(INSTALLED)"
	cp -R "$(BUNDLE)" "$(INSTALLED)"
	@echo "installed to $(INSTALLED); start it with make run (on launch it installs the daemon, or restarts it after an upgrade)"

run:
	open -a "$(INSTALLED)"

run-local: bundle stop
	open "$(BUNDLE)"

stop:
	-pkill -x "$(BIN)" 2>/dev/null || true

uninstall: stop
	-launchctl bootout "gui/$$(id -u)/local.sidekick.daemon" 2>/dev/null || true
	rm -f "$(HOME)/Library/LaunchAgents/local.sidekick.daemon.plist"
	rm -rf "$(INSTALLED)"

clean:
	rm -rf .build build
