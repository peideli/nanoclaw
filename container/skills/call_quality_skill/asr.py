"""
火山引擎 ASR 语音识别模块

提交录音 URL -> 轮询结果 -> 返回格式化的对话文本
"""

import json
import time
import uuid
import requests

from . import config


def _format_time(ms: int) -> str:
    """毫秒转为 mm:ss 格式"""
    if ms is None:
        return "N/A"
    seconds = ms // 1000
    minutes = seconds // 60
    seconds = seconds % 60
    return f"{minutes:02d}:{seconds:02d}"


def _submit_task(audio_url: str) -> tuple[str, str]:
    """向火山引擎提交 ASR 识别任务, 返回 (task_id, x_tt_logid)"""
    task_id = str(uuid.uuid4())
    headers = {
        "X-Api-App-Key": config.VOLC_ASR_APP_KEY,
        "X-Api-Access-Key": config.VOLC_ASR_ACCESS_KEY,
        "X-Api-Resource-Id": config.VOLC_ASR_RESOURCE_ID,
        "X-Api-Request-Id": task_id,
        "X-Api-Sequence": "-1",
    }

    request_data = {
        "user": {"uid": "call_quality_skill"},
        "audio": {"url": audio_url},
        "request": {
            "model_name": "bigmodel",
            "enable_channel_split": True,
            "enable_ddc": False,
            "enable_speaker_info": True,
            "enable_punc": True,
            "enable_itn": True,
            "channel": 2,
            "rate": 8000,
            "boosting_table_id": config.VOLC_ASR_BOOSTING_TABLE_ID,
            "boosting_table_name": "car_hotwords",
            "corpus": {"correct_table_name": "", "context": ""},
        },
    }

    resp = requests.post(
        config.VOLC_ASR_SUBMIT_URL,
        data=json.dumps(request_data),
        headers=headers,
        timeout=30,
    )

    status_code = resp.headers.get("X-Api-Status-Code", "")
    if status_code == "20000000":
        return task_id, resp.headers.get("X-Tt-Logid", "")

    raise RuntimeError(
        f"ASR 提交失败: status={status_code}, "
        f"message={resp.headers.get('X-Api-Message', 'unknown')}"
    )


def _query_task(task_id: str, x_tt_logid: str) -> requests.Response:
    """查询 ASR 任务结果"""
    headers = {
        "X-Api-App-Key": config.VOLC_ASR_APP_KEY,
        "X-Api-Access-Key": config.VOLC_ASR_ACCESS_KEY,
        "X-Api-Resource-Id": config.VOLC_ASR_RESOURCE_ID,
        "X-Api-Request-Id": task_id,
        "X-Tt-Logid": x_tt_logid,
    }
    return requests.post(
        config.VOLC_ASR_QUERY_URL,
        data=json.dumps({}),
        headers=headers,
        timeout=30,
    )


def _format_utterances(utterances: list) -> str:
    """将 ASR utterances 格式化为质检可读的对话文本"""
    lines = []
    for utt in utterances:
        start_time = utt.get("start_time", 0)
        end_time = utt.get("end_time", 0)
        text = utt.get("text", "")
        channel = utt.get("additions", {}).get("channel_id", "N/A")
        start_str = _format_time(start_time)
        end_str = _format_time(end_time)
        lines.append(f"t={start_str}-{end_str} spk={channel} {text}")
    return "\n".join(lines)


def recognize(audio_url: str, poll_interval: float = 2.0, max_wait: int = 300) -> str:
    """
    对录音 URL 执行 ASR 识别, 返回格式化后的对话文本

    Args:
        audio_url: 录音文件的 URL (mp3/wav 等)
        poll_interval: 轮询间隔(秒)
        max_wait: 最大等待时间(秒)

    Returns:
        格式化后的对话文本 (每行: t=mm:ss-mm:ss spk=N 文本)

    Raises:
        RuntimeError: 提交失败或识别超时/失败
    """
    task_id, x_tt_logid = _submit_task(audio_url)
    print(f"  [ASR] 任务已提交: {task_id[:8]}...")

    elapsed = 0.0
    while elapsed < max_wait:
        resp = _query_task(task_id, x_tt_logid)
        code = resp.headers.get("X-Api-Status-Code", "")

        if code == "20000000":  # 识别完成
            result_json = resp.json()
            utterances = result_json.get("result", {}).get("utterances", [])
            if not utterances:
                return "未能识别出任何语音内容。"
            text = _format_utterances(utterances)
            print(f"  [ASR] 识别完成, 共 {len(utterances)} 句")
            return text

        elif code in ("20000001", "20000002"):  # 排队中 / 处理中
            time.sleep(poll_interval)
            elapsed += poll_interval
        else:
            raise RuntimeError(f"ASR 识别失败, 错误码: {code}")

    raise RuntimeError(f"ASR 识别超时 (已等待 {max_wait}s)")
