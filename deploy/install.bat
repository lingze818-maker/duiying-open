@echo off
REM 企业记忆库一键部署（Windows）——内网机器无外网可用
REM 用法：把整个 duiying-open 目录拷到目标机，双击本脚本
REM 依赖：Node.js >= 22（离线安装包见 docs/安装手册.md 附录一）

setlocal
cd /d "%~dp0.."

echo [1/4] 检查 Node.js…
node --version >nul 2>&1
if errorlevel 1 (
  echo   未找到 node——请先按安装手册附录一离线安装 Node.js 22+
  pause & exit /b 1
)
echo   OK: node --version

echo [2/4] 安装可选依赖（向量检索；跳过则纯词面检索照常可用）…
if exist "vendor\offline-deps" (
  echo   从离线包安装…
  npm install --offline --no-audit --no-fund --cache "vendor\offline-deps" @huggingface/transformers || echo   离线包缺失，跳过向量依赖（纯词面模式）
) else (
  echo   无离线依赖包，跳过（纯词面模式；如需向量检索见手册第三章）
)

echo [3/4] 准备工作区配置…
if not exist "workspace\workspace.json" (
  mkdir workspace
  copy "examples\workspace-test\workspace.json" "workspace\workspace.json" >nul
  xcopy /e /i /y "examples\workspace-test\memories" "workspace\memories" >nul
  echo   已用示例配置初始化 workspace\（按手册第三章改成单位自己的分库）
) else (
  echo   已有 workspace 配置，保留不动
)

echo [4/4] 启动检索服务…
set ENTERPRISE_CONFIG=%cd%\workspace\workspace.json
set ENTERPRISE_DATA=%cd%\workspace
set PORT=8766
echo   地址：http://127.0.0.1:%PORT%  （Ctrl+C 停止服务）
node server\enterprise.mjs
