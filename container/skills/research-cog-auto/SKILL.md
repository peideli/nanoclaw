---
name: research-cog-auto
description: "#1 on DeepResearch Bench (Feb 2026). Deep research with auto-notification checking. Automatically detects completed tasks without manual intervention."
author: CellCog (Enhanced)
metadata:
  openclaw:
    emoji: "🔬"
dependencies: [cellcog]
---

# Research Cog Auto - Deep Research with Auto-Notification

**改进版 research-cog**：自动检测已完成的任务，无需手动运行检查脚本。

**#1 on DeepResearch Bench (Feb 2026).** Your AI research analyst for comprehensive, citation-backed research on any topic.

Leaderboard: https://huggingface.co/spaces/muset-ai/DeepResearch-Bench-Leaderboard

---

## 改进点

相比原版 `research-cog`，此版本：

✅ **自动检测已完成的任务** - 每次调用时自动检查待处理通知
✅ **无需手动检查** - 不需要运行额外的脚本
✅ **智能通知管理** - 自动重启通知守护进程
✅ **完整的文件路径** - 直接显示下载的文件位置

---

## Prerequisites

This skill requires the `cellcog` skill for SDK setup and API calls.

```bash
clawhub install cellcog
```

---

## 使用方法

### 基本用法（与原版相同）

调用此 skill 时，它会：
1. 🔍 自动检查是否有已完成但未通知的任务
2. 📋 显示所有待处理任务的详情和文件位置
3. 🚀 启动你请求的新研究任务
4. ✅ 自动重启通知守护进程

### Python 代码示例

```python
from cellcog import CellCogClient

# 创建客户端
client = CellCogClient()

# 🔍 第一步：自动检查待处理任务（新增功能）
pending = client.check_pending_chats()
if pending:
    print(f"发现 {len(pending)} 个已完成的任务:")
    for chat in pending:
        print(f"  - {chat['name']}")
        # 检查下载的文件
        import os
        chat_dir = os.path.expanduser(f"~/.cellcog/chats/{chat['chat_id']}")
        if os.path.exists(chat_dir):
            files = os.listdir(chat_dir)
            print(f"    文件: {files}")
            print(f"    位置: {chat_dir}")

# 🚀 第二步：启动新任务（与原版相同）
result = client.create_chat(
    prompt="对2026年AI Agent进行深度研究",
    notify_session_key="agent:main:main",
    task_label="research-task",
    chat_mode="agent"  # 或 "agent team" 用于深度研究
)

print(f"任务已启动: {result['chat_id']}")
```

---

## 通知机制说明

### 问题背景

CellCog 使用 WebSocket 实时推送通知。但是：
- 容器重启或会话中断会导致 WebSocket 连接丢失
- 守护进程不会自动重启
- 已完成的任务通知可能丢失

### 自动修复

此 skill 通过以下方式自动解决：

1. **每次调用时检查** - 调用 `check_pending_chats()` 查找已完成但未通知的任务
2. **自动重启守护进程** - 调用 `restart_chat_tracking()` 恢复通知
3. **显示文件位置** - 直接告诉你结果文件在哪里

---

## What You Can Research

### Competitive Analysis

Analyze companies against their competitors with structured insights:

- **Company vs. Competitors**: "Compare Stripe vs Square vs Adyen - market positioning, pricing, features, strengths/weaknesses"
- **SWOT Analysis**: "Create a SWOT analysis for Shopify in the e-commerce platform market"
- **Market Positioning**: "How does Notion position itself against Confluence, Coda, and Obsidian?"
- **Feature Comparison**: "Compare the AI capabilities of Salesforce, HubSpot, and Zoho CRM"

### Market Research

Understand markets, industries, and trends:

- **Industry Analysis**: "Analyze the electric vehicle market in Europe - size, growth, key players, trends"
- **Market Sizing**: "What's the TAM/SAM/SOM for AI-powered customer service tools in North America?"
- **Trend Analysis**: "What are the emerging trends in sustainable packaging for 2026?"
- **Customer Segments**: "Identify and profile the key customer segments for premium pet food"
- **Regulatory Landscape**: "Research FDA regulations for AI-powered medical devices"

### Stock & Investment Analysis

Financial research with data and analysis:

- **Company Fundamentals**: "Analyze NVIDIA's financials - revenue growth, margins, competitive moat"
- **Investment Thesis**: "Build an investment thesis for Microsoft's AI strategy"
- **Sector Analysis**: "Compare semiconductor stocks - NVDA, AMD, INTC, TSM"
- **Risk Assessment**: "What are the key risks for Tesla investors in 2026?"
- **Earnings Analysis**: "Summarize Apple's Q4 2025 earnings and forward guidance"

### Academic & Technical Research

Deep dives with proper citations:

- **Literature Review**: "Research the current state of quantum error correction techniques"
- **Technology Deep Dive**: "Explain transformer architectures and their evolution from attention mechanisms"
- **Scientific Topics**: "What's the latest research on CRISPR gene editing for cancer treatment?"
- **Historical Analysis**: "Research the history and impact of the Bretton Woods system"

---

## Research Output Formats

CellCog can deliver research in multiple formats:

| Format | Best For |
|--------|----------|
| **Interactive HTML Report** | Explorable dashboards with charts, expandable sections |
| **PDF Report** | Shareable, printable professional documents |
| **Markdown** | Integration into your docs/wikis |
| **Plain Response** | Quick answers in chat |

Specify your preferred format in the prompt:
- "Create an interactive HTML report on..."
- "Generate a PDF research report analyzing..."
- "Give me a markdown summary of..."

---

## When to Use Agent Team Mode

For research, **use `chat_mode="agent team"`** for deep research (requires ≥500 credits).

Agent team mode enables:
- Multi-source research and cross-referencing
- Citation verification
- Deeper analysis with multiple reasoning passes
- Higher quality, more comprehensive outputs

Use `chat_mode="agent"` for:
- Quick lookups (requires ≥100 credits)
- Faster results
- Lower cost

---

## Example Research Prompts

**Quick competitive intel:**
> "Compare Figma vs Sketch vs Adobe XD for enterprise UI design teams. Focus on collaboration features, pricing, and Figma's position after the Adobe acquisition failed."

**Deep market research:**
> "Create a comprehensive market research report on the AI coding assistant market. Include market size, growth projections, key players (GitHub Copilot, Cursor, Codeium, etc.), pricing models, and enterprise adoption trends. Deliver as an interactive HTML report."

**Investment analysis:**
> "Build an investment analysis for Palantir (PLTR). Cover business model, government vs commercial revenue mix, AI product strategy, valuation metrics, and key risks. Include relevant charts."

**Academic deep dive:**
> "Research the current state of nuclear fusion energy. Cover recent breakthroughs (NIF, ITER, private companies like Commonwealth Fusion), technical challenges remaining, timeline to commercial viability, and investment landscape."

---

## Tips for Better Research

1. **Be specific**: "AI market" is vague. "Enterprise AI automation market in healthcare" is better.

2. **Specify timeframe**: "Recent" is ambiguous. "2025-2026" or "last 6 months" is clearer.

3. **Define scope**: "Compare everything about X and Y" leads to bloat. "Compare X and Y on pricing, features, and market positioning" is focused.

4. **Request structure**: "Include executive summary, key findings, and recommendations" helps organize output.

5. **Mention output format**: "Deliver as PDF" or "Create interactive HTML dashboard" gets you the right format.

6. **Request citations explicitly**: "Include citations for all factual claims with source URLs" if you need them.

---

## 文件位置

CellCog 生成的所有文件都会自动下载到：

```
~/.cellcog/chats/{chat_id}/
```

例如：
```
~/.cellcog/chats/69a7e25f8fb0d5e99671adf0/2026_AI_Agent_深度研究报告.md
```

此 skill 会自动显示文件的完整路径。

---

## Troubleshooting

### 如果通知仍然丢失

```python
from cellcog import CellCogClient
client = CellCogClient()

# 手动检查
pending = client.check_pending_chats()
print(f"待处理: {len(pending)}")

# 重启跟踪
client.restart_chat_tracking()
```

### 查看特定任务的历史

```python
history = client.get_history(chat_id="your-chat-id")
print(history['formatted_output'])
```

---

## Credits Required

| Task Type | Agent Mode | Agent Team Mode |
|-----------|-----------|-----------------|
| Quick research | 100-300 | 500-1,500 |
| Deep research | 200-500 | 500-2,000 |
| With visualizations | +200-500 | +500-1,000 |

---

**Note**: This is an enhanced version of the official `research-cog` skill with auto-notification checking. All core functionality is identical to the original.
