"""Data schemas for Mini-Agent runner."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FunctionCall:
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolCall:
    id: str
    type: str
    function: FunctionCall


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class LLMResponse:
    content: str = ''
    thinking: str | None = None
    tool_calls: list[ToolCall] | None = None
    finish_reason: str = 'stop'
    usage: TokenUsage | None = None


@dataclass
class Message:
    role: str
    content: str | list = ''
    thinking: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    name: str | None = None

    def __post_init__(self):
        # Reconstruct ToolCall objects from dicts (e.g. when loading from JSON)
        if self.tool_calls and isinstance(self.tool_calls, list):
            reconstructed = []
            for tc in self.tool_calls:
                if isinstance(tc, dict):
                    func = tc.get('function', {})
                    reconstructed.append(ToolCall(
                        id=tc.get('id', ''),
                        type=tc.get('type', 'function'),
                        function=FunctionCall(
                            name=func.get('name', ''),
                            arguments=func.get('arguments', {}),
                        ),
                    ))
                else:
                    reconstructed.append(tc)
            self.tool_calls = reconstructed
