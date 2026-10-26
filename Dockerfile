# 仅供 MCP 目录（Glama 等）做构建 + introspection 自检使用。
# 这不是用户安装方式 —— 用户装 npm 包（npx -y feeling-search-mcp）。
# 本服务是 stdio ↔ HTTP 桥，容器内启动后会连远端 https://xiximm.cloud/mcp，
# 目录扫描器握手 initialize + tools/list 即可拿到 5 个工具。
FROM node:22-slim

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY README.md LICENSE ./

# stdio 传输：不要加 -i 之外的参数，stdout 只走协议消息
ENTRYPOINT ["node", "bin/cli.mjs"]
