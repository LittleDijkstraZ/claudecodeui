# CloudCLI — personal fork

This is [LittleDijkstraZ's fork](https://github.com/LittleDijkstraZ/claudecodeui) of
[CloudCLI UI by Siteboon](https://github.com/siteboon/claudecodeui).
The maintained customization branch is **`personal/cloudcli`**, based on upstream
**v1.37.2**. `main` is reserved for the upstream history.

## Changes in this fork

- Claude replies appear incrementally while they are generated. Each conversation
  has its own stream buffer, including when switching between conversations.
- The model menu offers **Ultracode** for Claude model entries that support
  `xhigh`. This enables Claude's automatic dynamic workflows and `xhigh` reasoning.
  Choosing Default or an ordinary effort level turns Ultracode off for that request.
- Workflow launch, progress, and completion are tracked separately, so launching
  background work does not immediately mark the whole request complete.
- Claude Agent SDK is pinned to **0.3.263** for reproducible builds.

These changes were added on **2026-09-07**. They are maintained by this fork and
are not an official Siteboon release. Upstream attribution and licensing are
preserved in [NOTICE](NOTICE) and [LICENSE](LICENSE).

## 使用方式

在聊天框旁打开模型菜单，选择支持该模式的 Claude 模型（例如 `Opus`、
`Sonnet` 或 `Fable`），然后选择 **Ultracode**。它会自动组织多个子任务，
通常使用更多 API tokens。选择 `Default`、`high` 等普通选项即可关闭。
模式选择对下一次发送生效。`Default` 模型、Haiku 和没有推理档位信息的自定义
模型条目不会显示该选项；先选择一个支持的内置模型。

模型仍然由你运行 CloudCLI 的服务器调用。要使用远端 Claude，下面的安装和
启动步骤都应在**远端服务器**执行，Mac 只通过已有的安全隧道打开网页。
不要在 Mac 启动第二份 CloudCLI 服务。

## Build on the machine that runs Claude

Requirements: Node.js 22 or later, npm, and Claude Code **2.1.203 or later**.
The development deployment uses Claude Code 2.1.263. Ultracode also requires a
model supporting `xhigh` and access to dynamic workflows.

```sh
git clone --branch personal/cloudcli https://github.com/LittleDijkstraZ/claudecodeui.git
cd claudecodeui
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build

export HOST=127.0.0.1
export SERVER_PORT=3001
export CLAUDE_CLI_PATH="$(command -v claude)"
test -n "$CLAUDE_CLI_PATH" && test -x "$CLAUDE_CLI_PATH" || exit 1
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_FEEDBACK_COMMAND=1
node dist-server/server/index.js
```

Use the server's existing Claude API authentication; do not commit credentials.
Connect through an existing Coder port forward or an SSH tunnel. For SSH, run on
your viewing machine:

```sh
ssh -N -L 3001:127.0.0.1:3001 user@your-server
```

Then open `http://127.0.0.1:3001`. The UI account database and Claude history stay
on the server that runs CloudCLI. This is not an outbound network firewall:
Claude sends task context to its configured model provider, and enabled network
tools or plugins can make additional requests.

Ultracode does not change CloudCLI's tool permission mode or automatically allow
the `Workflow` tool. Approve the requested tools through your existing permission
flow. For details, see Anthropic's [dynamic workflow documentation](https://code.claude.com/docs/en/workflows).
If the server sets `CLAUDE_CODE_EFFORT_LEVEL` to a value other than `xhigh`,
Claude's environment override takes precedence and automatic Ultracode
orchestration remains inactive.

## Maintenance

Build from `personal/cloudcli` to retain these changes. CloudCLI's upstream npm
updater can replace a custom installation with the official package; use Git and
rebuild this fork instead. Keep installation directories separate until a new
build passes checks, and switch only when the running service is idle.

The former edits to installed JavaScript bundles are now represented as source
changes and regression tests. Build outputs, local accounts, API keys, personal
launchers, and conversation files are not part of this repository.

See [upstream documentation](docs/README.md) for other CloudCLI features and
[fork validation notes](docs/personal-fork.md) for development details.
