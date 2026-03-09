#!/usr/bin/env python3
"""
CellCog Auto-Check Module
自动检查并报告待处理的 CellCog 任务

使用方法：
    在调用 research-cog skill 之前，先导入并运行此模块

    from auto_check import check_and_report
    check_and_report()
"""

import os
import sys

def check_and_report():
    """
    检查待处理的 CellCog 任务并报告
    返回待处理任务的数量
    """
    # 检查 API Key
    api_key = os.environ.get('CELLCOG_API_KEY')
    if not api_key:
        print("⚠️  CELLCOG_API_KEY 未设置", file=sys.stderr)
        return 0

    try:
        from cellcog import CellCogClient

        client = CellCogClient()

        # 检查账户
        account = client.get_account_status()
        if not account.get('configured'):
            print("⚠️  CellCog 未配置", file=sys.stderr)
            return 0

        # 检查待处理的聊天
        pending = client.check_pending_chats()

        if not pending:
            print("✓ 没有待处理的 CellCog 任务")
            # 重启跟踪以便接收未来的通知
            client.restart_chat_tracking()
            return 0

        # 报告待处理的任务
        print(f"\n{'='*60}")
        print(f"🔔 自动检测到 {len(pending)} 个已完成的 CellCog 任务")
        print(f"{'='*60}\n")

        for i, chat in enumerate(pending, 1):
            chat_id = chat.get('chat_id', 'unknown')
            name = chat.get('name', 'Untitled')
            preview = chat.get('last_message_preview', '')

            print(f"[{i}] {name}")
            print(f"    Chat ID: {chat_id}")

            # 检查状态
            try:
                status = client.get_status(chat_id=chat_id)
                is_operating = status.get('is_operating', False)

                if is_operating:
                    print(f"    状态: 🔄 仍在运行中")
                else:
                    print(f"    状态: ✅ 已完成")

                    # 显示预览（前100个字符）
                    if preview:
                        preview_clean = preview.replace('\n', ' ')[:100]
                        print(f"    预览: {preview_clean}...")

                    # 检查下载的文件
                    chat_dir = os.path.expanduser(f"~/.cellcog/chats/{chat_id}")
                    if os.path.exists(chat_dir):
                        files = [f for f in os.listdir(chat_dir) if not f.startswith('.')]
                        if files:
                            print(f"    📁 文件: {', '.join(files)}")
                            print(f"    📂 位置: {chat_dir}")

                            # 如果是 markdown 文件，可以直接读取
                            for f in files:
                                if f.endswith('.md'):
                                    file_path = os.path.join(chat_dir, f)
                                    print(f"    💡 提示: 使用 Read 工具读取: {file_path}")

            except Exception as e:
                print(f"    ⚠️  无法获取状态: {e}")

            print()

        # 重启跟踪
        print("🔄 重启 CellCog 通知跟踪...\n")
        client.restart_chat_tracking()

        print(f"{'='*60}\n")

        return len(pending)

    except ImportError:
        print("❌ CellCog SDK 未安装", file=sys.stderr)
        print("   运行: pip install cellcog", file=sys.stderr)
        return 0
    except Exception as e:
        print(f"❌ 检查时出错: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 0


def main():
    """命令行入口"""
    count = check_and_report()
    sys.exit(0 if count >= 0 else 1)


if __name__ == "__main__":
    main()
