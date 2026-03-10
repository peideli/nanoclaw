"""
LLM 通话质检模块

使用 Qwen 大模型对 ASR 识别文本进行质检分析
"""

import json
import re
from openai import OpenAI

from . import config
from .prompt import SYSTEM_PROMPT_V2


# 模块级别初始化客户端 (复用连接)
_client = OpenAI(
    api_key=config.DASHSCOPE_API_KEY,
    base_url=config.DASHSCOPE_BASE_URL,
)


def _parse_result(raw_text: str) -> dict:
    """解析大模型返回的质检结果 JSON"""
    text = raw_text.strip()

    # 去除 markdown code fence
    code_block = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if code_block:
        text = code_block.group(1).strip()

    # 提取 JSON 对象
    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        text = json_match.group(0)

    try:
        result = json.loads(text)
        if "质检结果" in result and isinstance(result["质检结果"], list):
            return result
        return {"error": "JSON结构不符合预期", "raw": raw_text, "parsed": result}
    except json.JSONDecodeError as e:
        return {"error": f"JSON解析失败: {e}", "raw": raw_text}


def check(dialogue_text: str) -> dict:
    """
    调用 Qwen 大模型进行通话质检

    Args:
        dialogue_text: ASR 识别后的对话文本

    Returns:
        质检结果字典, 包含 "质检结果" 列表
    """
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT_V2},
        {
            "role": "user",
            "content": f"以下是通话内容记录，请作为质检员进行判定：\n\n{dialogue_text}",
        },
    ]

    try:
        response = _client.chat.completions.create(
            model=config.QC_MODEL_NAME,
            messages=messages,
            temperature=0.1,
        )
        raw_text = response.choices[0].message.content.strip()
        return _parse_result(raw_text)
    except Exception as e:
        return {"error": f"调用大模型报错: {e}"}
