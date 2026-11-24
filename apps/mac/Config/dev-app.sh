#!/bin/sh
# The build phase "Dev app". The release app (bot.wizards.mac) passes through unchanged. The dev app,
# the Debug build with the bundle id bot.wizards.mac.dev, gets:
#
#   - LaunchAgents of its own: bot.wizards.home.dev and bot.wizards.link.dev, made from the release
#     plists, each naming the dev app in AssociatedBundleIdentifiers. The release plists leave its
#     bundle, so it cannot register the installed app's Bot Server.
#   - Contents/Resources/checkout.plist: the checkout it was built from and a Node 24.11 or newer
#     (WIZARDS_DEV_NODE, which `pnpm dev:mac` sets, else the `node` of the PATH or of the login
#     shell). Its Bot Server runs apps/home/src/cli.ts of that checkout with that Node.
#
# Identity.swift holds the same names for the code.
set -eu

release=bot.wizards.mac
[ "$PRODUCT_BUNDLE_IDENTIFIER" = "$release" ] && exit 0
case $PRODUCT_BUNDLE_IDENTIFIER in
"$release".*) suffix=${PRODUCT_BUNDLE_IDENTIFIER#"$release"} ;;
*)
	echo "error: the bundle id $PRODUCT_BUNDLE_IDENTIFIER is neither $release nor $release.<name>." >&2
	exit 1
	;;
esac

contents="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH"

# ── LaunchAgents ──
agents="$contents/Library/LaunchAgents"
for plist in "$agents"/*.plist; do
	[ -f "$plist" ] || continue
	label=$(plutil -extract Label raw -o - "$plist")
	case $label in *"$suffix") continue ;; esac
	own="$agents/$label$suffix.plist"
	cp "$plist" "$own"
	plutil -replace Label -string "$label$suffix" "$own"
	plutil -replace AssociatedBundleIdentifiers -json "[\"$PRODUCT_BUNDLE_IDENTIFIER\"]" "$own"
	rm "$plist"
done

# ── The checkout and its Node ──
checkout=$(cd "$SRCROOT/../.." && pwd -P)
node=${WIZARDS_DEV_NODE:-}
[ -n "$node" ] || node=$(command -v node 2>/dev/null || true)
[ -n "$node" ] || node=$("${SHELL:-/bin/zsh}" -l -c 'command -v node' 2>/dev/null </dev/null | tail -n 1 || true)
if [ -n "$node" ] && [ -x "$node" ] &&
	"$node" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 11) ? 0 : 1)' 2>/dev/null; then
	:
else
	echo "warning: no Node 24.11 or newer found${node:+ ($node)}: this dev app offers no \"Start on this Mac\". Build it with pnpm dev:mac, or set WIZARDS_DEV_NODE."
	node=""
fi

out="$contents/Resources/checkout.plist"
mkdir -p "$contents/Resources"
rm -f "$out"
plutil -create xml1 "$out"
plutil -insert checkout -string "$checkout" "$out"
[ -z "$node" ] || plutil -insert node -string "$node" "$out"
echo "Dev app: $PRODUCT_BUNDLE_IDENTIFIER runs the Bot Server of $checkout with ${node:-no Node}."
