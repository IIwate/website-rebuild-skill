# tools/ — 产物侧

这里的东西**生产**：分层表、依赖闭包、逐字切片、模块提名。允许 devDependencies，
因为作用域安全的分析需要真正的 parser（`@babel/parser` / `@babel/traverse`）。

⛔ **`scripts/` 里的任何门都不许 import 这里的任何文件。** 检查者不能是生产者
（`references/verification-gates.md` §2.1.2）。这条由 `scripts/verify-zerodep.mjs` 守着。

| 工具 | 用途 |
|---|---|
| `webpack-map.mjs` | 从 AST 读 webpack 模块容器，逐模块给出行区间、`requires`、导出名 |
| `closure.mjs` | 从种子模块算传递依赖闭包，竖切边界的唯一依据 |
| `slice-modules.mjs` | 按模块 id 逐字切片，`--check` 重切须字节一致 |
| `name-modules.mjs` | 按 0–4 级证据给模块提名，并记下依据的那句话 |

⚠ 复制到复刻项目时放在项目的 `tools/` 下，与项目 `package.json` 的 devDependencies 一起走。
