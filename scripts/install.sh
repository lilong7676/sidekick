#!/bin/bash
# Install or upgrade Sidekick.app from the latest GitHub release (betas included). Safe to run again:
# running it again is how you upgrade.
#
#   curl -fsSL https://raw.githubusercontent.com/lilong7676/sidekick/main/scripts/install.sh | bash
#
# Downloaded with curl, the app carries no quarantine flag, so there is nothing to clear by hand and
# Gatekeeper does not stop it. SIDEKICK_VERSION=v0.1.0-beta.4 installs that release instead.
set -euo pipefail
# Always ${brace} variables: macOS bash 3.2 in a UTF-8 locale reads "$tag。" as a variable named "tag。".

REPO="lilong7676/sidekick"
APP="/Applications/Sidekick.app"

say() { printf '%s\n' "$*"; }
die() { printf 'sidekick 安装：%s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "只支持 macOS。"
[ "$(uname -m)" = "arm64" ] || die "目前只有 Apple 芯片（M 系列）的版本。"

tag="${SIDEKICK_VERSION:-}"
if [ -z "${tag}" ]; then
  # The releases feed on github.com, newest first, prereleases included (/releases/latest skips them).
  # Not the API: unauthenticated it allows 60 calls an hour per IP, an office behind one proxy shares
  # them, and installs failed with 403. Each entry links its release as …/releases/tag/<tag>.
  # awk reads it all: an early-exiting grep would SIGPIPE curl, and pipefail would call that a failure.
  tag="$(curl -fsSL "https://github.com/${REPO}/releases.atom" |
    awk -F'/releases/tag/' '/rel="alternate"/ && NF > 1 && !found { split($2, t, "\""); print t[1]; found = 1 }')" ||
    die "查不到最新版本（网络不通，或者仓库还没公开）。"
fi
[ -n "${tag}" ] || die "查不到最新版本。"
# The tag goes into URLs and file names, so it must look like one of ours.
version_re='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
[[ "${tag}" =~ ${version_re} ]] || die "版本号不对：${tag}"

installed=""
if [ -d "${APP}" ]; then
  installed="v$(plutil -extract CFBundleShortVersionString raw "${APP}/Contents/Info.plist" 2>/dev/null || true)"
fi
if [ "${installed}" = "${tag}" ]; then
  say "已经是最新版 ${tag}。"
  open "${APP}"
  exit 0
fi

zip="Sidekick-${tag}.zip"
base="https://github.com/${REPO}/releases/download/${tag}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

say "下载 Sidekick ${tag}…"
curl -fL --progress-bar -o "${tmp}/${zip}" "${base}/${zip}" || die "下载 ${zip} 失败。"
curl -fsSL -o "${tmp}/${zip}.sha256" "${base}/${zip}.sha256" || die "下载校验文件失败。"
(cd "${tmp}" && shasum -a 256 -c "${zip}.sha256" >/dev/null) || die "校验没通过，安装包可能不完整，重新运行一次试试。"
ditto -x -k "${tmp}/${zip}" "${tmp}/out"
[ -d "${tmp}/out/Sidekick.app" ] || die "安装包里没有 Sidekick.app。"

# Quit the menu bar app; the daemon keeps running and is switched to the new binary when the new app
# opens (it notices the binary changed and restarts it).
pkill -x SidekickBar 2>/dev/null || true
sleep 1
rm -rf "${APP}"
ditto "${tmp}/out/Sidekick.app" "${APP}"
open "${APP}"

if [ -n "${installed}" ] && [ "${installed}" != "v" ]; then
  say "已从 ${installed} 升级到 ${tag}。正在跑的任务会重新排队，几秒后接着处理。"
else
  say "已装好 Sidekick ${tag}。点菜单栏的 ✨，选一个文件夹当工作区，再按提示登录 Slack。"
fi
