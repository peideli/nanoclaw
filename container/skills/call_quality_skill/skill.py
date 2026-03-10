"""
通话质检 Skill — 主编排器

完整流程: 解析录音 URL -> 火山引擎 ASR -> Qwen 质检 -> 输出结果
"""

import json
import re
import time

from .asr import recognize as asr_recognize
from .qc import check as qc_check


class CallQualitySkill:
    """
    通话质检 Skill

    用法:
        skill = CallQualitySkill()

        # 方式1: 直接传入录音 URL
        result = skill.run("https://example.com/recording.mp3")

        # 方式2: 传入已有的 ASR 文本 (跳过 ASR 步骤)
        result = skill.run_with_text("t=00:00-00:05 spk=1 你好...")

        # 方式3: 从文本中自动提取 URL 后执行
        result = skill.run_from_text("请质检这段录音 https://xxx.com/a.mp3 谢谢")
    """

    @staticmethod
    def extract_urls(text: str) -> list[str]:
        """从文本中提取所有 HTTP/HTTPS URL"""
        pattern = r"https?://[^\s<>\"'，。）)}\]]*"
        urls = re.findall(pattern, text)
        # 过滤出看起来像音频文件的 URL (mp3/wav/m4a/ogg/flac) 或通用 URL
        return urls

    def run(self, audio_url: str) -> dict:
        """
        完整流程: ASR 识别 + LLM 质检

        Args:
            audio_url: 录音文件 URL

        Returns:
            {
                "audio_url": "...",
                "asr_text": "...",
                "qc_result": {...},
                "timestamp": "...",
                "duration_seconds": ...
            }
        """
        start_time = time.time()
        print(f"[质检] 开始处理: {audio_url}")

        # Step 1: ASR
        print("[质检] 步骤 1/2: ASR 语音识别...")
        asr_text = asr_recognize(audio_url)

        # Step 2: LLM 质检
        print("[质检] 步骤 2/2: LLM 质检分析...")
        qc_result = qc_check(asr_text)

        elapsed = time.time() - start_time
        print(f"[质检] 完成! 耗时 {elapsed:.1f}s")

        return {
            "audio_url": audio_url,
            "asr_text": asr_text,
            "qc_result": qc_result,
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "duration_seconds": round(elapsed, 1),
        }

    def run_with_text(self, dialogue_text: str) -> dict:
        """
        跳过 ASR, 直接对已有文本进行 LLM 质检

        Args:
            dialogue_text: 对话文本

        Returns:
            质检结果字典
        """
        start_time = time.time()
        print("[质检] 直接文本质检 (跳过 ASR)...")

        qc_result = qc_check(dialogue_text)

        elapsed = time.time() - start_time
        print(f"[质检] 完成! 耗时 {elapsed:.1f}s")

        return {
            "asr_text": dialogue_text,
            "qc_result": qc_result,
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "duration_seconds": round(elapsed, 1),
        }

    def run_from_text(self, text: str) -> list[dict]:
        """
        从文本中自动提取录音 URL, 逐一执行质检

        Args:
            text: 包含录音 URL 的文本

        Returns:
            每个 URL 对应的质检结果列表
        """
        urls = self.extract_urls(text)
        if not urls:
            return [{"error": "未在文本中发现有效的录音 URL"}]

        print(f"[质检] 从文本中提取到 {len(urls)} 个 URL")
        results = []
        for i, url in enumerate(urls, 1):
            print(f"\n[质检] === 处理第 {i}/{len(urls)} 个 ===")
            result = self.run(url)
            results.append(result)

        return results

    @staticmethod
    def format_report(result: dict) -> str:
        """
        将质检结果格式化为人类可读的报告

        Args:
            result: run() 返回的结果字典

        Returns:
            格式化的文本报告
        """
        lines = []
        lines.append("=" * 50)
        lines.append("通话质检报告")
        lines.append("=" * 50)

        if "audio_url" in result:
            lines.append(f"录音: {result['audio_url']}")
        lines.append(f"时间: {result.get('timestamp', 'N/A')}")
        lines.append(f"耗时: {result.get('duration_seconds', 'N/A')}s")
        lines.append("")

        qc = result.get("qc_result", {})
        if "error" in qc:
            lines.append(f"[错误] {qc['error']}")
            return "\n".join(lines)

        items = qc.get("质检结果", [])
        hit_items = [i for i in items if i.get("是否命中")]
        pass_items = [i for i in items if not i.get("是否命中")]

        if hit_items:
            lines.append("--- 命中违规项 ---")
            for item in hit_items:
                level = item.get("严重等级", "")
                tag = "[红线]" if level == "红线" else "[黄线]"
                lines.append(f"  {tag} {item['质检项']}")
                lines.append(f"       依据: {item.get('依据', '无')}")
            lines.append("")

        lines.append(f"--- 质检通过项 ({len(pass_items)}/{len(items)}) ---")
        for item in pass_items:
            lines.append(f"  [通过] {item['质检项']}")

        lines.append("=" * 50)
        return "\n".join(lines)
