"""Built-in tools for the Mini-Agent runner."""

import asyncio
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


@dataclass
class ToolResult:
    success: bool
    content: str = ''
    error: str | None = None


class Tool:
    """Base tool class."""

    @property
    def name(self) -> str:
        raise NotImplementedError

    @property
    def description(self) -> str:
        raise NotImplementedError

    @property
    def parameters(self) -> dict[str, Any]:
        raise NotImplementedError

    async def execute(self, **kwargs) -> ToolResult:
        raise NotImplementedError

    def to_openai_schema(self) -> dict[str, Any]:
        return {
            'type': 'function',
            'function': {
                'name': self.name,
                'description': self.description,
                'parameters': self.parameters,
            },
        }


class BashTool(Tool):
    def __init__(self, cwd: str):
        self.cwd = cwd

    @property
    def name(self) -> str:
        return 'bash'

    @property
    def description(self) -> str:
        return """Execute a bash command. Use for system operations, git, npm, docker, etc.
- Quote file paths with spaces
- Chain commands with && for dependent ops
- Use timeout parameter for long-running commands (default 120s, max 600s)"""

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'command': {
                    'type': 'string',
                    'description': 'The bash command to execute',
                },
                'timeout': {
                    'type': 'integer',
                    'description': 'Timeout in seconds (default 120, max 600)',
                    'default': 120,
                },
            },
            'required': ['command'],
        }

    async def execute(self, command: str, timeout: int = 120, **kwargs) -> ToolResult:
        timeout = min(max(timeout, 1), 600)
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                return ToolResult(success=False, error=f'Command timed out after {timeout}s')

            stdout_text = stdout.decode('utf-8', errors='replace')
            stderr_text = stderr.decode('utf-8', errors='replace')

            output = stdout_text
            if stderr_text:
                output += f'\n[stderr]:\n{stderr_text}'

            if proc.returncode == 0:
                return ToolResult(success=True, content=output or '(no output)')
            else:
                return ToolResult(
                    success=False,
                    content=output,
                    error=f'Command failed with exit code {proc.returncode}',
                )
        except Exception as e:
            return ToolResult(success=False, error=str(e))


class ReadFileTool(Tool):
    @property
    def name(self) -> str:
        return 'read_file'

    @property
    def description(self) -> str:
        return 'Read the contents of a file. Returns the full file content.'

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'file_path': {
                    'type': 'string',
                    'description': 'Path to the file to read',
                },
                'offset': {
                    'type': 'integer',
                    'description': 'Line number to start reading from (1-indexed)',
                },
                'limit': {
                    'type': 'integer',
                    'description': 'Maximum number of lines to read',
                },
            },
            'required': ['file_path'],
        }

    async def execute(self, file_path: str, offset: int = 0, limit: int = 0, **kwargs) -> ToolResult:
        try:
            with open(file_path, 'r', errors='replace') as f:
                lines = f.readlines()

            if offset > 0:
                lines = lines[offset - 1:]
            if limit > 0:
                lines = lines[:limit]

            # Add line numbers
            start = max(offset, 1)
            numbered = [f'{start + i}\t{line.rstrip()}' for i, line in enumerate(lines)]
            return ToolResult(success=True, content='\n'.join(numbered))
        except FileNotFoundError:
            return ToolResult(success=False, error=f'File not found: {file_path}')
        except Exception as e:
            return ToolResult(success=False, error=str(e))


class WriteFileTool(Tool):
    @property
    def name(self) -> str:
        return 'write_file'

    @property
    def description(self) -> str:
        return 'Write content to a file. Creates the file if it does not exist, overwrites if it does.'

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'file_path': {
                    'type': 'string',
                    'description': 'Path to the file to write',
                },
                'content': {
                    'type': 'string',
                    'description': 'Content to write to the file',
                },
            },
            'required': ['file_path', 'content'],
        }

    async def execute(self, file_path: str, content: str, **kwargs) -> ToolResult:
        try:
            os.makedirs(os.path.dirname(file_path) or '.', exist_ok=True)
            with open(file_path, 'w') as f:
                f.write(content)
            return ToolResult(success=True, content=f'Written {len(content)} chars to {file_path}')
        except Exception as e:
            return ToolResult(success=False, error=str(e))


class EditFileTool(Tool):
    @property
    def name(self) -> str:
        return 'edit_file'

    @property
    def description(self) -> str:
        return 'Edit a file by replacing an exact string with a new string. The old_string must be unique in the file.'

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'file_path': {
                    'type': 'string',
                    'description': 'Path to the file to edit',
                },
                'old_string': {
                    'type': 'string',
                    'description': 'The exact text to find and replace',
                },
                'new_string': {
                    'type': 'string',
                    'description': 'The text to replace it with',
                },
            },
            'required': ['file_path', 'old_string', 'new_string'],
        }

    async def execute(self, file_path: str, old_string: str, new_string: str, **kwargs) -> ToolResult:
        try:
            with open(file_path, 'r') as f:
                content = f.read()

            count = content.count(old_string)
            if count == 0:
                return ToolResult(success=False, error='old_string not found in file')
            if count > 1:
                return ToolResult(success=False, error=f'old_string found {count} times (must be unique)')

            new_content = content.replace(old_string, new_string, 1)
            with open(file_path, 'w') as f:
                f.write(new_content)
            return ToolResult(success=True, content=f'Edited {file_path}')
        except FileNotFoundError:
            return ToolResult(success=False, error=f'File not found: {file_path}')
        except Exception as e:
            return ToolResult(success=False, error=str(e))


class GlobTool(Tool):
    @property
    def name(self) -> str:
        return 'glob'

    @property
    def description(self) -> str:
        return 'Find files matching a glob pattern. Returns matching file paths.'

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'pattern': {
                    'type': 'string',
                    'description': 'Glob pattern (e.g., "**/*.py", "src/**/*.ts")',
                },
                'path': {
                    'type': 'string',
                    'description': 'Directory to search in (default: current directory)',
                },
            },
            'required': ['pattern'],
        }

    async def execute(self, pattern: str, path: str = '.', **kwargs) -> ToolResult:
        try:
            import glob as g
            matches = sorted(g.glob(os.path.join(path, pattern), recursive=True))
            if not matches:
                return ToolResult(success=True, content='No matches found')
            return ToolResult(success=True, content='\n'.join(matches[:500]))
        except Exception as e:
            return ToolResult(success=False, error=str(e))


class GrepTool(Tool):
    @property
    def name(self) -> str:
        return 'grep'

    @property
    def description(self) -> str:
        return 'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.'

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'pattern': {
                    'type': 'string',
                    'description': 'Regex pattern to search for',
                },
                'path': {
                    'type': 'string',
                    'description': 'File or directory to search (default: current directory)',
                },
                'glob_filter': {
                    'type': 'string',
                    'description': 'Glob pattern to filter files (e.g., "*.py")',
                },
            },
            'required': ['pattern'],
        }

    async def execute(self, pattern: str, path: str = '.', glob_filter: str = '', **kwargs) -> ToolResult:
        try:
            cmd = ['grep', '-rn', '--include', glob_filter, pattern, path] if glob_filter else ['grep', '-rn', pattern, path]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            output = stdout.decode('utf-8', errors='replace')
            if not output:
                return ToolResult(success=True, content='No matches found')
            # Limit output
            lines = output.split('\n')
            if len(lines) > 200:
                output = '\n'.join(lines[:200]) + f'\n... ({len(lines) - 200} more lines)'
            return ToolResult(success=True, content=output)
        except asyncio.TimeoutError:
            return ToolResult(success=False, error='grep timed out after 30s')
        except Exception as e:
            return ToolResult(success=False, error=str(e))


class WebSearchTool(Tool):
    @property
    def name(self) -> str:
        return 'web_search'

    @property
    def description(self) -> str:
        return 'Search the web. Returns search results with titles, URLs, and snippets.'

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'The search query',
                },
            },
            'required': ['query'],
        }

    async def execute(self, query: str, **kwargs) -> ToolResult:
        # Use a simple curl-based search (DuckDuckGo lite)
        try:
            proc = await asyncio.create_subprocess_exec(
                'curl', '-sL', f'https://lite.duckduckgo.com/lite/?q={query}',
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            html = stdout.decode('utf-8', errors='replace')
            # Extract text content roughly
            import re
            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()
            return ToolResult(success=True, content=text[:5000])
        except Exception as e:
            return ToolResult(success=False, error=f'Web search failed: {e}')


class WebFetchTool(Tool):
    @property
    def name(self) -> str:
        return 'web_fetch'

    @property
    def description(self) -> str:
        return 'Fetch content from a URL. Returns the page content as text.'

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            'type': 'object',
            'properties': {
                'url': {
                    'type': 'string',
                    'description': 'The URL to fetch',
                },
            },
            'required': ['url'],
        }

    async def execute(self, url: str, **kwargs) -> ToolResult:
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
                resp = await client.get(url)
                content_type = resp.headers.get('content-type', '')
                if 'text/html' in content_type:
                    text = re.sub(r'<[^>]+>', ' ', resp.text)
                    text = re.sub(r'\s+', ' ', text).strip()
                    return ToolResult(success=True, content=text[:10000])
                else:
                    return ToolResult(success=True, content=resp.text[:10000])
        except Exception as e:
            return ToolResult(success=False, error=f'Fetch failed: {e}')


def create_tools(workspace_dir: str) -> list[Tool]:
    """Create all built-in tools."""
    return [
        BashTool(cwd=workspace_dir),
        ReadFileTool(),
        WriteFileTool(),
        EditFileTool(),
        GlobTool(),
        GrepTool(),
        WebSearchTool(),
        WebFetchTool(),
    ]
