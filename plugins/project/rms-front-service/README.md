# rms-front-service（面向项目的特定插件）

在本地**完整启动** rms-front（Spring Boot + Thymeleaf 前后端一体工程）的本地服务，并管理其状态、日志与停止。

只有前后端同时起来，`http://rms.dev.huizhi-intl.com/rms/ui/#/dashboard` 才能渲染出真实前端页面：
页面 HTML 由后端 **80** 渲染，Vue 源码与 HMR 资产由 `frontend-ui` 的 Vite dev server（**5174**）提供。

规约见 [`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md)；启动顺序依据 rms-front `AGENTS.md`「本地启动与验证方法」。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | 可移植清单 + 零依赖实现（含进程拉起/探活/日志） |
| `dsh/host.mjs` | dsh 适配器：把 `tools` 注册到 `ctx.tools` |

## 工具

| MCP 全名 | 说明 |
|---|---|
| `rms-front-service__rms_front_start` | 完整启动（前端 5174 + 后端 80） |
| `rms-front-service__rms_front_status` | 进程存活 / 端口监听 / `/rms/ui/` 探活 / 日志尾部 |
| `rms-front-service__rms_front_stop` | 按记录的 PID 结束整棵进程树，释放 80 与 5174 |
| `rms-front-service__rms_front_logs` | 读后端/前端日志尾部，支持子串过滤 |

### `rms_front_start` 参数（均可省略）

| 参数 | 默认 | 说明 |
|---|---|---|
| `project_root` | `C:/Users/admin/IdeaProjects/rms-front` | 仓库根目录 |
| `frontend_dir` | `frontend-ui` | 前端目录（相对 `project_root`） |
| `java_home` | `C:/Users/admin/.jdks/ms-11.0.29` | 后端所用 JDK11 根目录（pom 指定 `java.version=11`） |
| `skip_frontend` | `false` | 只起后端（生产式验证，需先 `npm run build`） |
| `skip_backend` | `false` | 只起前端 dev server |
| `force` | `false` | 已有存活实例时先结束再拉起 |
| `wait_seconds` | `0` | 启动后最多等多少秒做就绪探测再返回 |

## 运行时事实（排障要点）

- 状态写在 `%TEMP%\rms-front-service\state.json`；日志写 `%TEMP%\rms-front-service\backend.log` 与 `frontend.log`。
- 进程用 **非 detached** 方式拉起，这是实测结论：`detached:true` 时 node/mvn 这类外部程序的输出会**全部丢失**
  （日志恒 0 字节，与 `windowsHide`、fd 还是 `>` 重定向均无关）；只有 `detached:false` 才把输出落盘。
- 代价：包装用的 `cmd.exe` 会随 MCP server（Trae 重载/重启）一并结束，而它启动的 java/vite 仍存活，
  于是 `state.json` 记录的 PID 失效、端口仍被占用。因此 `stop`/`start` 除记录 PID 外还**按 80/5174 端口兜底**：
  `rms_front_stop` 按端口结束持有者；`rms_front_start` 启动前也清理端口上的残留实例。
  （必须清理：`frontend-ui/vite.config.ts` 的 `strictPort:false` 会让新 vite 静默漂移到 5175，而后端仍指向 5174 的旧实例。）
- 后端命令：`mvn spring-boot:run -Dspring-boot.run.arguments=--spring.config.location=classpath:base-config.yml,classpath:application-dev.yml`
  （配置文件缺一会启动失败或连错环境）。
- 前端命令：`npm run dev`（= `vite`，`frontend-ui/vite.config.ts` 固定 `server.port: 5174`）。
- 后端首次启动要 Maven 编译 + 加载依赖，通常数十秒（实测约 60s 才绑定 80）；用 `rms_front_status` / `rms_front_logs` 观察。
- `stop` 会结束 80/5174 上的监听进程，**包括非本插件拉起的实例**（如 IDEA Run Configuration）。这两个端口由本插件视为独占管辖。

## 接入与验证

dsh 侧由项目覆盖层 [`dsh/cordis.yml`](../../../dsh/cordis.yml) 登记；MCP 侧由 `mcp/server.mjs` 自动扫描。

```powershell
# dsh 冒烟（cwd 必须是 deepseek-harness/）
"" | pnpm dsh acp --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml"

# MCP 平面：stdio 握手后调 rms-front-service__rms_front_status
node "C:/Users/admin/Documents/trae_projects/rms_dsh/mcp/server.mjs"
```
