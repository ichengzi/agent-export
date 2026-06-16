# agent-export

把本机的 Codex 或 Claude session 导出成一个可直接浏览器打开的单文件 HTML。

## 特性

- 纯 JS
- 支持 `codex` 和 `claude`
- 输出单文件 HTML
- 页面内支持搜索、仅看对话、复制会话 ID、复制 resume、复制路径

## 安装

```bash
npm install -g agent-export
```

或本地开发直接执行：

```bash
node ./bin/agent-export.js <session-id>
```

## 用法

```bash
agent-export <session-id>
agent-export <session-id> --provider codex
agent-export <session-id> --provider claude
agent-export <session-id> --output ./claude-session.html
```

## 默认行为

- 不传 `--provider` 时，先查 `codex`，再查 `claude`
- 默认输出文件名为 `{provider}-{sessionId}.html`
- 默认读取：
  - Codex: `~/.codex`
  - Claude: `~/.claude`

## 选项

- `--provider <codex|claude>`
- `--codex-dir <path>`
- `--claude-dir <path>`
- `--output, --out <path>`
- `--id <session-id>`
- `-h, --help`

## 依赖

这个包本身是纯 JS，但导出 Codex session 时依赖本机 `sqlite3` 命令。

Claude 导出不依赖 `sqlite3`。
