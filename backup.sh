#!/bin/bash
# 每日备份：小楼data + 听澍的脚本/记忆 → github.com/boluomihaochi/nuoshen-data (私有)
set -e
cd /root/nuoshen-home/data

# 让解析器把最新会话补进 chatlog-cache
curl -s -m 120 http://localhost:3721/api/chatlog/dates > /dev/null || true

# 顺带备份 VPS 上重建环境要用的东西（不含 token/密钥）
mkdir -p vps-files
rsync -a --delete /root/tingshu/CLAUDE.md /root/tingshu/chatlog.sh /root/tingshu/fishing.py /root/tingshu/fishing_save.json vps-files/tingshu/ 2>/dev/null || true
rsync -a --delete /root/.claude/projects/-root-tingshu/memory/ vps-files/memory/ 2>/dev/null || true

git add -A
git diff --cached --quiet && exit 0   # 没变化就不提交
git commit -q -m "backup $(date +%F)"
git push -q -u origin main
