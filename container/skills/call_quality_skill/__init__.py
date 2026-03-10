"""
通话质检 Skill — 一键完成 ASR 语音识别 + LLM 质检

使用方法:
    from call_quality_skill import CallQualitySkill

    skill = CallQualitySkill()
    result = skill.run("https://example.com/recording.mp3")
"""

from .skill import CallQualitySkill

__all__ = ["CallQualitySkill"]
