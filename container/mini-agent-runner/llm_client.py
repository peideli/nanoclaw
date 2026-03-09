"""LLM client using OpenAI-compatible API (works with MiniMax, Qwen, Kimi, DeepSeek)."""

import json
import re
import sys
from typing import Any

from openai import AsyncOpenAI

from schema import FunctionCall, LLMResponse, Message, TokenUsage, ToolCall


class LLMClient:
    """OpenAI-compatible LLM client with tool calling support."""

    def __init__(self, api_base: str, api_key: str, model: str):
        self.model = model
        self.client = AsyncOpenAI(
            api_key=api_key,
            base_url=api_base,
            timeout=120.0,
        )

    async def generate(
        self,
        messages: list[Message],
        tools: list[Any] | None = None,
    ) -> LLMResponse:
        # Convert messages
        api_messages = self._convert_messages(messages)

        # Build params
        params: dict[str, Any] = {
            'model': self.model,
            'messages': api_messages,
        }

        if tools:
            params['tools'] = self._convert_tools(tools)

        try:
            response = await self.client.chat.completions.create(**params)
        except Exception as e:
            print(f'[agent-runner] LLM API error: {e}', file=sys.stderr, flush=True)
            raise

        return self._parse_response(response)

    def _convert_messages(self, messages: list[Message]) -> list[dict[str, Any]]:
        api_messages = []
        for msg in messages:
            if msg.role == 'system':
                api_messages.append({'role': 'system', 'content': msg.content})
            elif msg.role == 'user':
                api_messages.append({'role': 'user', 'content': msg.content})
            elif msg.role == 'assistant':
                assistant_msg: dict[str, Any] = {'role': 'assistant'}
                if msg.content:
                    assistant_msg['content'] = msg.content
                if msg.tool_calls:
                    assistant_msg['tool_calls'] = [
                        {
                            'id': tc.id,
                            'type': 'function',
                            'function': {
                                'name': tc.function.name,
                                'arguments': json.dumps(tc.function.arguments),
                            },
                        }
                        for tc in msg.tool_calls
                    ]
                api_messages.append(assistant_msg)
            elif msg.role == 'tool':
                api_messages.append({
                    'role': 'tool',
                    'tool_call_id': msg.tool_call_id,
                    'content': msg.content if isinstance(msg.content, str) else str(msg.content),
                })
        return api_messages

    def _convert_tools(self, tools: list[Any]) -> list[dict[str, Any]]:
        result = []
        for tool in tools:
            if isinstance(tool, dict):
                if 'type' in tool and tool['type'] == 'function':
                    result.append(tool)
                else:
                    result.append({
                        'type': 'function',
                        'function': {
                            'name': tool['name'],
                            'description': tool['description'],
                            'parameters': tool.get('input_schema', tool.get('parameters', {})),
                        },
                    })
            elif hasattr(tool, 'to_openai_schema'):
                result.append(tool.to_openai_schema())
            elif hasattr(tool, 'name') and hasattr(tool, 'description') and hasattr(tool, 'parameters'):
                result.append({
                    'type': 'function',
                    'function': {
                        'name': tool.name,
                        'description': tool.description,
                        'parameters': tool.parameters,
                    },
                })
        return result

    def _parse_response(self, response: Any) -> LLMResponse:
        message = response.choices[0].message

        text_content = message.content or ''

        # Extract thinking — some models embed it in <think> tags within content
        thinking_content = None
        think_match = re.match(r'^<think>\s*(.*?)\s*</think>\s*(.*)', text_content, re.DOTALL)
        if think_match:
            thinking_content = think_match.group(1).strip()
            text_content = think_match.group(2).strip()

        # Also check reasoning_details field (some models use this)
        if not thinking_content and hasattr(message, 'reasoning_details') and message.reasoning_details:
            parts = []
            for detail in message.reasoning_details:
                if hasattr(detail, 'text'):
                    parts.append(detail.text)
            if parts:
                thinking_content = ''.join(parts)

        # Extract tool calls
        tool_calls = []
        if message.tool_calls:
            for tc in message.tool_calls:
                arguments = json.loads(tc.function.arguments) if isinstance(tc.function.arguments, str) else tc.function.arguments
                tool_calls.append(ToolCall(
                    id=tc.id,
                    type='function',
                    function=FunctionCall(
                        name=tc.function.name,
                        arguments=arguments,
                    ),
                ))

        # Extract usage
        usage = None
        if hasattr(response, 'usage') and response.usage:
            usage = TokenUsage(
                prompt_tokens=response.usage.prompt_tokens or 0,
                completion_tokens=response.usage.completion_tokens or 0,
                total_tokens=response.usage.total_tokens or 0,
            )

        return LLMResponse(
            content=text_content,
            thinking=thinking_content,
            tool_calls=tool_calls if tool_calls else None,
            finish_reason='stop',
            usage=usage,
        )


def create_llm_client(api_base: str, api_key: str, model: str) -> LLMClient:
    return LLMClient(api_base=api_base, api_key=api_key, model=model)
