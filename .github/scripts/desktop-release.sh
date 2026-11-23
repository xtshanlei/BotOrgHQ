#!/usr/bin/env bash
set -euo pipefail

version="$(node -p 'require("./desktop/package.json").version')"
test "$version" = "$(node -p 'require("./package.json").version')"
tag="v${version}-desktop"
windows="BotOrgHQ-${version}-win-x64.exe"
apple="BotOrgHQ-${version}-mac-arm64.zip"
intel="BotOrgHQ-${version}-mac-x64.zip"
plugin="bot-org-hq-${version}.tgz"

require_draft() {
  local target
  target="$(gh release view "$tag" --json isDraft,targetCommitish --jq 'select(.isDraft) | .targetCommitish')"
  if [ "$target" != "$GITHUB_SHA" ]; then
    printf 'Expected a draft release for %s\n' "$GITHUB_SHA" >&2
    return 1
  fi
}

case "$1" in
  stage)
    printf 'tag=%s\n' "$tag" >> "$GITHUB_OUTPUT"
    if release="$(gh release view "$tag" --json isDraft,targetCommitish 2>/dev/null)"; then
      if jq -e '.isDraft == false' <<< "$release" >/dev/null; then
        printf 'build=false\n' >> "$GITHUB_OUTPUT"
        exit 0
      fi
      require_draft >/dev/null
    else
      base="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
      download="$base/releases/download/$tag"
      gh release create "$tag" --draft --prerelease --target "$GITHUB_SHA" \
        --title "BotOrgHQ $version Desktop" --notes-file - <<EOF
### English

- Switch between English and Simplified Chinese in the BotOrgHQ workbench. The preference is shared with DSH and applies to the desktop menus, updates, and profile transfer.
- The English and Chinese READMEs explain how a Chief Bot can pursue an authorised goal, delegate work, and deliver reviewable evidence.
- To update in place, open **Help → Check for updates…**. The app backs up your DSH profile before installing.

### 简体中文

- 在 BotOrgHQ 工作台切换英语与简体中文。偏好与 DSH 共用，桌面菜单、更新和数据迁移界面也会跟随切换。
- 中英文 README 详细介绍 Chief 如何持续推进授权目标、分派工作并交付可复核的证据。
- 打开 **帮助 → 检查更新…** 执行原地升级。安装前，应用会备份 DSH 用户数据。

| Platform / 平台 | Download / 下载 |
| --- | --- |
| macOS · Apple Silicon | [$apple]($download/$apple) |
| macOS · Intel | [$intel]($download/$intel) |
| Windows · x64 | [$windows]($download/$windows) |
| DSH plugin / 插件 | [$plugin]($download/$plugin) |

The macOS app is ad-hoc signed and has not been notarised. The Windows installer is unsigned.
macOS 应用采用 ad-hoc 签名，尚未公证。Windows 安装器未签名。

[SHA-256]($download/SHA256SUMS.txt) · [English README]($base/blob/$tag/README.md) · [中文使用说明]($base/blob/$tag/README.zh-CN.md)
EOF
    fi
    printf 'build=true\n' >> "$GITHUB_OUTPUT"
    ;;
  upload)
    test "$TAG" = "$tag"
    shift
    test "$#" -gt 0
    for file in "$@"; do test -s "$file"; done
    require_draft >/dev/null
    gh release upload "$tag" "$@" --clobber
    ;;
  publish)
    test "$TAG" = "$tag"
    require_draft
    release_id="$(gh release view "$tag" --json databaseId --jq .databaseId)"
    assets="$(gh api "repos/$GITHUB_REPOSITORY/releases/$release_id/assets?per_page=100")"
    for file in "$windows" "$apple" "$intel" "$plugin"; do
      jq -er --arg file "$file" '
        [.[] | select(.name == $file and .state == "uploaded" and .size > 0 and (.digest | test("^sha256:[a-f0-9]{64}$")))]
        | if length == 1 then (.[0].digest | sub("^sha256:"; "")) + "  " + $file
          else error("Missing or invalid release asset " + $file)
          end
      ' <<< "$assets"
    done > SHA256SUMS.txt
    gh release upload "$tag" SHA256SUMS.txt --clobber
    gh release edit "$tag" --draft=false
    gh release view "$tag" --json url,isDraft,assets --jq '{url,isDraft,assets:[.assets[].name]}'
    ;;
  *) exit 2 ;;
esac
