"""MCP tool loader — connects to NanoClaw IPC MCP server (Node.js stdio)."""

import asyncio
import json
import os
import sys
from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from tools import Tool, ToolResult


class MCPTool(Tool):
    """Wrapper around an MCP tool."""

    def __init__(self, tool_name: str, tool_description: str, tool_params: dict, session: ClientSession):
        self._name = tool_name
        self._description = tool_description
        self._parameters = tool_params
        self._session = session

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs) -> ToolResult:
        try:
            result = await asyncio.wait_for(
                self._session.call_tool(self._name, arguments=kwargs),
                timeout=60,
            )
            parts = []
            for item in result.content:
                if hasattr(item, 'text'):
                    parts.append(item.text)
                else:
                    parts.append(str(item))

            content = '\n'.join(parts)
            is_error = getattr(result, 'isError', False)
            return ToolResult(
                success=not is_error,
                content=content,
                error='Tool returned error' if is_error else None,
            )
        except asyncio.TimeoutError:
            return ToolResult(success=False, error='MCP tool timed out after 60s')
        except Exception as e:
            return ToolResult(success=False, error=f'MCP tool failed: {e}')


# Global state for cleanup
_exit_stack: AsyncExitStack | None = None


async def load_mcp_tools(
    server_name: str,
    command: str,
    args: list[str],
    env: dict[str, str] | None = None,
) -> list[Tool]:
    """Connect to an MCP server via stdio and load its tools."""
    global _exit_stack

    full_env = {**os.environ, **(env or {})}

    _exit_stack = AsyncExitStack()

    server_params = StdioServerParameters(
        command=command,
        args=args,
        env=full_env,
    )

    read_stream, write_stream = await _exit_stack.enter_async_context(
        stdio_client(server_params)
    )

    session = await _exit_stack.enter_async_context(
        ClientSession(read_stream, write_stream)
    )

    await session.initialize()
    tools_list = await session.list_tools()

    tools = []
    for tool in tools_list.tools:
        params = tool.inputSchema if hasattr(tool, 'inputSchema') else {}
        mcp_tool = MCPTool(
            tool_name=tool.name,
            tool_description=tool.description or '',
            tool_params=params,
            session=session,
        )
        tools.append(mcp_tool)
        print(f'[agent-runner] MCP tool: {tool.name}', file=sys.stderr, flush=True)

    return tools


async def cleanup_mcp():
    """Clean up MCP connections."""
    global _exit_stack
    if _exit_stack:
        try:
            await _exit_stack.aclose()
        except Exception:
            pass
        _exit_stack = None
