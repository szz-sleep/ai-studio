#!/bin/bash
# AI Studio 启动脚本 (macOS/Linux)
# 用 Python 启动一个轻量 HTTP 服务器，避免 file:// 协议可能带来的问题

echo "🚀 AI Studio 启动中..."
echo ""
echo "请在浏览器中打开以下地址："
echo "  →  http://localhost:8080"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""

cd "$(dirname "$0")"
python3 -m http.server 8080
