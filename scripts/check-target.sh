#!/usr/bin/env bash
# NanoClaw 目标机器环境诊断脚本
# 在 VPS 上运行，将输出粘贴回来即可

echo "=== NanoClaw Target Diagnostics ==="
echo "Date: $(date)"
echo ""

echo "--- OS ---"
uname -a
cat /etc/os-release 2>/dev/null | head -5
echo ""

echo "--- Architecture ---"
uname -m
dpkg --print-architecture 2>/dev/null || rpm --eval '%{_arch}' 2>/dev/null || echo "unknown"
echo ""

echo "--- Docker ---"
docker --version 2>/dev/null || echo "Docker NOT installed"
docker compose version 2>/dev/null || docker-compose --version 2>/dev/null || echo "Docker Compose NOT found"
docker info --format '{{.ServerVersion}}' 2>/dev/null || echo "Docker daemon not running"
docker info --format 'Storage Driver: {{.Driver}}' 2>/dev/null
echo ""

echo "--- Docker Socket ---"
ls -la /var/run/docker.sock 2>/dev/null || echo "/var/run/docker.sock NOT found"
echo ""

echo "--- Disk Space ---"
df -h / | tail -1
echo ""

echo "--- Memory ---"
free -h 2>/dev/null | head -2 || echo "free command not available"
echo ""

echo "--- Port 3000 ---"
ss -tlnp 2>/dev/null | grep ':3000' || netstat -tlnp 2>/dev/null | grep ':3000' || echo "Port 3000 is free"
echo ""

echo "--- Existing NanoClaw ---"
docker ps -a --filter name=nanoclaw 2>/dev/null || echo "No containers"
docker images --filter reference='nanoclaw-*' 2>/dev/null || echo "No images"
echo ""

echo "=== Done ==="
