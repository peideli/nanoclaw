"""Core Agent loop — adapted from Mini-Agent for NanoClaw container use."""

import asyncio
import json
import sys
from typing import Any, Optional

import tiktoken

from schema import LLMResponse, Message, ToolCall, FunctionCall


class Agent:
    """Agent with tool-use loop, context management, and cancellation support."""

    def __init__(
        self,
        llm_client: Any,
        system_prompt: str,
        tools: list[Any],
        max_steps: int = 100,
        workspace_dir: str = './workspace',
        token_limit: int = 80000,
    ):
        self.llm = llm_client
        self.tools = {tool.name: tool for tool in tools}
        self.max_steps = max_steps
        self.token_limit = token_limit
        self.workspace_dir = workspace_dir
        self.cancel_event: Optional[asyncio.Event] = None

        self.system_prompt = system_prompt
        self.messages: list[Message] = [Message(role='system', content=system_prompt)]

        self.api_total_tokens: int = 0
        self._skip_next_token_check: bool = False

    def add_user_message(self, content: str) -> None:
        self.messages.append(Message(role='user', content=content))

    def _check_cancelled(self) -> bool:
        return self.cancel_event is not None and self.cancel_event.is_set()

    def _estimate_tokens(self) -> int:
        try:
            encoding = tiktoken.get_encoding('cl100k_base')
        except Exception:
            total = sum(len(str(m.content)) for m in self.messages)
            return int(total / 2.5)

        total = 0
        for msg in self.messages:
            if isinstance(msg.content, str):
                total += len(encoding.encode(msg.content))
            if msg.thinking:
                total += len(encoding.encode(msg.thinking))
            if msg.tool_calls:
                total += len(encoding.encode(str(msg.tool_calls)))
            total += 4  # message overhead
        return total

    async def _summarize_if_needed(self) -> None:
        if self._skip_next_token_check:
            self._skip_next_token_check = False
            return

        estimated = self._estimate_tokens()
        should_summarize = estimated > self.token_limit or self.api_total_tokens > self.token_limit
        if not should_summarize:
            return

        _log(f'Token usage: estimated={estimated}, api={self.api_total_tokens}, limit={self.token_limit}. Summarizing...')

        user_indices = [i for i, m in enumerate(self.messages) if m.role == 'user' and i > 0]
        if len(user_indices) < 1:
            return

        new_messages = [self.messages[0]]  # system prompt

        for i, user_idx in enumerate(user_indices):
            new_messages.append(self.messages[user_idx])
            next_idx = user_indices[i + 1] if i < len(user_indices) - 1 else len(self.messages)
            execution_msgs = self.messages[user_idx + 1:next_idx]

            if execution_msgs:
                summary = self._quick_summary(execution_msgs, i + 1)
                new_messages.append(Message(role='user', content=f'[Previous execution summary]\n\n{summary}'))

        self.messages = new_messages
        self._skip_next_token_check = True
        new_tokens = self._estimate_tokens()
        _log(f'Summary done: {estimated} -> {new_tokens} tokens')

    def _quick_summary(self, messages: list[Message], round_num: int) -> str:
        """Create a quick local summary without LLM call."""
        parts = []
        for msg in messages:
            if msg.role == 'assistant':
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                if content:
                    parts.append(f'Assistant: {content[:500]}')
                if msg.tool_calls:
                    names = [tc.function.name for tc in msg.tool_calls]
                    parts.append(f'  Tools called: {", ".join(names)}')
            elif msg.role == 'tool':
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                parts.append(f'  Tool result: {content[:200]}...')
        return '\n'.join(parts) if parts else f'Round {round_num}: (no notable output)'

    async def run(self, cancel_event: Optional[asyncio.Event] = None) -> str:
        if cancel_event is not None:
            self.cancel_event = cancel_event

        step = 0
        while step < self.max_steps:
            if self._check_cancelled():
                return 'Task cancelled.'

            await self._summarize_if_needed()

            _log(f'Step {step + 1}/{self.max_steps}')

            tool_list = list(self.tools.values())

            try:
                response: LLMResponse = await self.llm.generate(
                    messages=self.messages, tools=tool_list
                )
            except Exception as e:
                error_msg = f'LLM call failed: {e}'
                _log(error_msg)
                return error_msg

            if response.usage:
                self.api_total_tokens = response.usage.total_tokens

            # Add assistant message
            self.messages.append(Message(
                role='assistant',
                content=response.content,
                thinking=response.thinking,
                tool_calls=response.tool_calls,
            ))

            if response.thinking:
                _log(f'Thinking: {response.thinking[:200]}...')

            if response.content:
                _log(f'Assistant: {response.content[:200]}...')

            # No tool calls = task complete
            if not response.tool_calls:
                return response.content

            if self._check_cancelled():
                return 'Task cancelled.'

            # Execute tool calls
            for tool_call in response.tool_calls:
                tool_name = tool_call.function.name
                arguments = tool_call.function.arguments

                _log(f'Tool: {tool_name}({json.dumps({k: str(v)[:100] for k, v in arguments.items()})})')

                if tool_name not in self.tools:
                    result_content = f'Error: Unknown tool: {tool_name}'
                    success = False
                else:
                    try:
                        tool = self.tools[tool_name]
                        result = await tool.execute(**arguments)
                        result_content = result.content if result.success else f'Error: {result.error}'
                        success = result.success
                    except Exception as e:
                        result_content = f'Error: Tool execution failed: {e}'
                        success = False

                if success:
                    _log(f'  Result: {result_content[:200]}...')
                else:
                    _log(f'  Error: {result_content[:200]}')

                self.messages.append(Message(
                    role='tool',
                    content=result_content,
                    tool_call_id=tool_call.id,
                    name=tool_name,
                ))

                if self._check_cancelled():
                    return 'Task cancelled.'

            step += 1

        return f'Task could not be completed after {self.max_steps} steps.'

    def get_history(self) -> list[Message]:
        return self.messages.copy()


def _log(msg: str) -> None:
    print(f'[agent-runner] {msg}', file=sys.stderr, flush=True)
