# Saury

Saury 是一个运行在 Linux 上的轻量级 QQ 协议网关，基于 Satori v1 协议构建。

## 特性

- **架构极简**：单 Node.js 进程配合极简的 C++ 原生兼容层运行，不使用内存补丁或 Hook。
- **开箱即用**：首次启动时自动按系统架构下载并提取官方 Linux QQ 核心文件，无需手动寻找和配置客户端依赖。
- **标准协议**：提供 Satori v1 HTTP API、WebSocket 事件流（支持断线重连事件恢复）、文件上传及内部资源代理。
- **核心能力**：支持文字、图片、提及（@）、引用回复、消息撤回、单条消息读取，以及用户、好友、群组和群成员查询。

## 快速开始

推荐使用容器部署。镜像已包含全部运行依赖，首次启动时会自动拉取所需的 QQ 资源。

### 1. 构建并启动容器

可以使用 Podman 或 Docker 运行。建议启动时显式指定 `SAURY_TOKEN`，以便后续在机器人框架中配置连接：

```bash
podman build -f Containerfile -t localhost/saury .

podman run -d --name saury --userns=keep-id \
  -p 127.0.0.1:5500:5500 \
  -e SAURY_TOKEN=your_secret_token \
  -v saury-data:/data \
  localhost/saury
```

### 2. 扫码登录

查看容器日志获取登录二维码（同时也会保存在数据目录的 `session/qrcode.png` 中）：

```bash
podman logs -f saury
```

### 3. 接入机器人框架

在 Koishi（`@koishijs/plugin-adapter-satori`）或 NoneBot（`nonebot-adapter-satori`）中配置以下连接信息：

- **HTTP API 地址**：`http://127.0.0.1:5500`
- **WebSocket 地址**：`ws://127.0.0.1:5500/v1/events`
- **Token**：填写启动时设置的 `SAURY_TOKEN`

## 从源码构建

如果在宿主机直接运行，需准备以下环境：
- Linux 系统
- Node.js 24 及以上、pnpm 12
- C++ 编译器、`make`、`flock`、`dpkg-deb`
- 官方 Linux QQ 所需的系统级动态库依赖

编译并启动：

```bash
pnpm install --frozen-lockfile
pnpm build
./src/saury.sh
```

> 若需覆盖原生编译使用的 Node 头文件目录，可通过环境变量 `NODE_INCLUDE` 指定。

## 配置说明

Saury 通过环境变量进行配置：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SAURY_DATA` | `~/.local/share/saury` | 数据目录（遵循 `XDG_DATA_HOME`，容器内默认为 `/data`） |
| `SAURY_TOKEN` | 随机生成（仅当次有效） | Satori 访问令牌，接入外部框架时请显式设置固定值 |
| `SAURY_ACCOUNT` | 首个可快速登录的账号 | 限制仅允许指定的 QQ 号登录，扫码账号不匹配时将拒绝启动 |
| `SAURY_HOST` | `127.0.0.1` | 服务监听地址 |
| `SAURY_PORT` | `5500` | HTTP 与 WebSocket 共用端口 |
| `SAURY_LOG` | `info` | 日志级别，可选 `debug`、`info`、`warn`、`error` |
