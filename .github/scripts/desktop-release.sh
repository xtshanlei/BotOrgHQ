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
### 新功能

- Chief 可按计划或事件推进授权目标、跨部门分派工作，并把结果和证据写回看板。
- 主动自治默认关闭。工作台提供权限、预算、审批、紧急暂停和影子回放。
- 桌面版可加密导出和导入本地 DSH 数据，包括配置、Bot、组织、对话、附件和记忆。导入保留目标机器原数据，并暂停导入的自治任务。
- 内置 DeepSeek Harness 0.2.2-rc.2。应用内升级会在安装前备份现有数据。

| 平台 | 下载 |
| --- | --- |
| Apple 芯片 Mac | [$apple]($download/$apple) |
| Intel Mac | [$intel]($download/$intel) |
| Windows x64 | [$windows]($download/$windows) |
| DSH 插件 | [$plugin]($download/$plugin) |

macOS 应用使用 ad-hoc 签名，尚未公证。Windows 安装器未签名。

[SHA-256 校验]($download/SHA256SUMS.txt) · [使用说明]($base/blob/$tag/docs/proactive-user-guide.md) · [迁移与恢复]($base/blob/$tag/docs/proactive-migration.md)
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
