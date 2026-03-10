"""
NanoClaw Agent Runner (Mini-Agent engine)
Runs inside a container, receives config via stdin, outputs result to stdout.

Input protocol:
  Stdin: Full ContainerInput JSON (read until EOF)
  IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
         Files: {type:"message", text:"..."}.json — polled and consumed
         Sentinel: /workspace/ipc/input/_close — signals session end

Stdout protocol:
  Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
"""

import asyncio
import json
import os
import sys
import time
import glob as glob_module
from pathlib import Path

from agent import Agent
from llm_client import create_llm_client
from tools import create_tools
from schema import Message

# Protocol markers (must match container-runner.ts)
OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---'
OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---'

IPC_INPUT_DIR = '/workspace/ipc/input'
IPC_INPUT_CLOSE_SENTINEL = os.path.join(IPC_INPUT_DIR, '_close')
IPC_POLL_MS = 0.5  # seconds

# Session persistence path
SESSION_FILE = '/workspace/group/.mini-agent-session.json'


def log(message: str) -> None:
    """Log to stderr (same as Node.js agent-runner)."""
    print(f'[agent-runner] {message}', file=sys.stderr, flush=True)


def write_output(output: dict) -> None:
    """Write output with markers to stdout."""
    print(OUTPUT_START_MARKER, flush=True)
    print(json.dumps(output), flush=True)
    print(OUTPUT_END_MARKER, flush=True)


def read_stdin() -> str:
    """Read all of stdin."""
    return sys.stdin.read()


def should_close() -> bool:
    """Check for _close sentinel."""
    if os.path.exists(IPC_INPUT_CLOSE_SENTINEL):
        try:
            os.unlink(IPC_INPUT_CLOSE_SENTINEL)
        except OSError:
            pass
        return True
    return False


def drain_ipc_input() -> list[str]:
    """Drain all pending IPC input messages."""
    try:
        os.makedirs(IPC_INPUT_DIR, exist_ok=True)
        files = sorted(
            f for f in os.listdir(IPC_INPUT_DIR) if f.endswith('.json')
        )
        messages = []
        for f in files:
            filepath = os.path.join(IPC_INPUT_DIR, f)
            try:
                with open(filepath, 'r') as fh:
                    data = json.load(fh)
                os.unlink(filepath)
                if data.get('type') == 'message' and data.get('text'):
                    messages.append(data['text'])
            except Exception as err:
                log(f'Failed to process input file {f}: {err}')
                try:
                    os.unlink(filepath)
                except OSError:
                    pass
        return messages
    except Exception as err:
        log(f'IPC drain error: {err}')
        return []


async def wait_for_ipc_message() -> str | None:
    """Wait for a new IPC message or _close sentinel."""
    while True:
        if should_close():
            return None
        messages = drain_ipc_input()
        if messages:
            return '\n'.join(messages)
        await asyncio.sleep(IPC_POLL_MS)


def load_session() -> list[dict] | None:
    """Load saved session messages."""
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, 'r') as f:
                return json.load(f)
        except Exception as err:
            log(f'Failed to load session: {err}')
    return None


def save_session(messages: list[Message]) -> None:
    """Save session messages for resume."""
    try:
        data = []
        for msg in messages:
            entry = {'role': msg.role, 'content': msg.content}
            if msg.thinking:
                entry['thinking'] = msg.thinking
            if msg.tool_calls:
                entry['tool_calls'] = [
                    {
                        'id': tc.id,
                        'type': tc.type,
                        'function': {
                            'name': tc.function.name,
                            'arguments': tc.function.arguments,
                        },
                    }
                    for tc in msg.tool_calls
                ]
            if msg.tool_call_id:
                entry['tool_call_id'] = msg.tool_call_id
            if msg.name:
                entry['name'] = msg.name
            data.append(entry)
        with open(SESSION_FILE, 'w') as f:
            json.dump(data, f)
    except Exception as err:
        log(f'Failed to save session: {err}')


def build_system_prompt(container_input: dict) -> str:
    """Build system prompt from CLAUDE.md files and context."""
    parts = []

    # Load group CLAUDE.md
    group_claude_md = '/workspace/group/CLAUDE.md'
    if os.path.exists(group_claude_md):
        with open(group_claude_md, 'r') as f:
            parts.append(f.read())

    # Load global CLAUDE.md (non-main only)
    if not container_input.get('isMain'):
        global_claude_md = '/workspace/global/CLAUDE.md'
        if os.path.exists(global_claude_md):
            with open(global_claude_md, 'r') as f:
                parts.append(f.read())

    # Load user memory
    user_memory = '/workspace/user/memory.md'
    if os.path.exists(user_memory):
        with open(user_memory, 'r') as f:
            content = f.read().strip()
            if content:
                parts.append(f'## User Memory\n\n{content}')

    # Load extra directories CLAUDE.md
    extra_base = '/workspace/extra'
    if os.path.exists(extra_base):
        for entry in os.listdir(extra_base):
            extra_claude = os.path.join(extra_base, entry, 'CLAUDE.md')
            if os.path.exists(extra_claude):
                with open(extra_claude, 'r') as f:
                    parts.append(f.read())

    # Add assistant identity
    assistant_name = container_input.get('assistantName', 'Assistant')
    base_prompt = f"""You are {assistant_name}, a helpful AI assistant. You have access to tools for executing shell commands, reading/writing files, and interacting with the NanoClaw system.

## Working Directory
You are working in: /workspace/group
All relative paths resolve relative to this directory.

## Available Capabilities
- Execute shell commands (bash)
- Read, write, and edit files
- Search files by name (glob) and content (grep)
- Browse the web (web_search, web_fetch)
- Send messages and manage tasks via NanoClaw MCP tools
"""

    # Load skills from /home/node/.claude/skills/
    skills_dir = '/home/node/.claude/skills'
    if os.path.isdir(skills_dir):
        skill_docs = []
        for skill_name in sorted(os.listdir(skills_dir)):
            skill_path = os.path.join(skills_dir, skill_name)
            if not os.path.isdir(skill_path):
                continue
            # Look for documentation/instructions in the skill
            doc = ''
            for doc_file in ['README.md', 'INSTRUCTIONS.md', 'skill.py']:
                doc_path = os.path.join(skill_path, doc_file)
                if os.path.exists(doc_path):
                    with open(doc_path, 'r') as f:
                        doc = f.read()
                    break
            if doc:
                skill_docs.append(f'### Skill: {skill_name}\n\nLocation: `{skill_path}`\n\n{doc}')
        if skill_docs:
            base_prompt += '\n## Available Skills\n\nThe following skills are installed and available via Python. Use `python3` to import and run them.\n\n' + '\n\n---\n\n'.join(skill_docs)

    if parts:
        base_prompt += '\n## Project Context\n\n' + '\n\n---\n\n'.join(parts)

    return base_prompt


async def run_query(
    agent: Agent,
    prompt: str,
    container_input: dict,
) -> dict:
    """Run a single agent query with IPC polling."""

    # Add user message
    agent.add_user_message(prompt)

    # Set up IPC polling during query
    ipc_polling = True
    closed_during_query = False

    async def poll_ipc():
        nonlocal ipc_polling, closed_during_query
        while ipc_polling:
            if should_close():
                log('Close sentinel detected during query')
                closed_during_query = True
                if agent.cancel_event:
                    agent.cancel_event.set()
                ipc_polling = False
                return
            messages = drain_ipc_input()
            for text in messages:
                log(f'Piping IPC message into active query ({len(text)} chars)')
                agent.add_user_message(text)
            await asyncio.sleep(IPC_POLL_MS)

    # Run agent and IPC polling concurrently
    cancel_event = asyncio.Event()
    agent.cancel_event = cancel_event

    ipc_task = asyncio.create_task(poll_ipc())

    try:
        result = await agent.run(cancel_event)
    finally:
        ipc_polling = False
        ipc_task.cancel()
        try:
            await ipc_task
        except asyncio.CancelledError:
            pass

    # Extract token usage
    token_input = 0
    token_output = 0
    if hasattr(agent, 'api_total_tokens'):
        # Rough split: 70% input, 30% output (Mini-Agent doesn't track separately)
        token_input = int(agent.api_total_tokens * 0.7)
        token_output = int(agent.api_total_tokens * 0.3)

    return {
        'result': result,
        'closed_during_query': closed_during_query,
        'token_input': token_input,
        'token_output': token_output,
    }


async def main() -> None:
    # Read container input from stdin
    try:
        stdin_data = read_stdin()
        container_input = json.loads(stdin_data)
        log(f'Received input for group: {container_input.get("groupFolder")}')
    except Exception as err:
        write_output({
            'status': 'error',
            'result': None,
            'error': f'Failed to parse input: {err}',
        })
        sys.exit(1)

    # Read LLM config from environment
    api_base = os.environ.get('AGENT_API_BASE', '')
    api_key = os.environ.get('AGENT_API_KEY', '')
    model = os.environ.get('AGENT_MODEL', 'MiniMax-M2.5')

    if not api_base or not api_key:
        write_output({
            'status': 'error',
            'result': None,
            'error': 'AGENT_API_BASE and AGENT_API_KEY must be set',
        })
        sys.exit(1)

    log(f'Using LLM: {model} at {api_base}')

    # Create LLM client
    llm_client = create_llm_client(api_base, api_key, model)

    # Build system prompt
    system_prompt = build_system_prompt(container_input)

    # Create tools (bash, file ops, glob, grep, web)
    tools = create_tools('/workspace/group')

    # Load MCP tools (NanoClaw IPC)
    mcp_tools = []
    mcp_server_path = '/tmp/dist/ipc-mcp-stdio.js'
    if os.path.exists(mcp_server_path):
        from mcp_loader import load_mcp_tools
        try:
            mcp_tools = await load_mcp_tools(
                'nanoclaw',
                command='node',
                args=[mcp_server_path],
                env={
                    'NANOCLAW_CHAT_JID': container_input.get('chatJid', ''),
                    'NANOCLAW_GROUP_FOLDER': container_input.get('groupFolder', ''),
                    'NANOCLAW_IS_MAIN': '1' if container_input.get('isMain') else '0',
                },
            )
            log(f'Loaded {len(mcp_tools)} MCP tools')
        except Exception as err:
            log(f'Failed to load MCP tools: {err}')

    all_tools = tools + mcp_tools

    # Create agent
    agent = Agent(
        llm_client=llm_client,
        system_prompt=system_prompt,
        tools=all_tools,
        max_steps=100,
        workspace_dir='/workspace/group',
        token_limit=80000,
    )

    # Restore session if resuming
    session_id = container_input.get('sessionId')
    if session_id:
        saved = load_session()
        if saved:
            log(f'Restoring session with {len(saved)} messages')
            agent.messages = [Message(**m) for m in saved]

    os.makedirs(IPC_INPUT_DIR, exist_ok=True)
    # Clean up stale _close sentinel
    try:
        os.unlink(IPC_INPUT_CLOSE_SENTINEL)
    except OSError:
        pass

    # Build initial prompt
    prompt = container_input.get('prompt', '')
    if container_input.get('isScheduledTask'):
        prompt = f'[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n{prompt}'
    pending = drain_ipc_input()
    if pending:
        log(f'Draining {len(pending)} pending IPC messages into initial prompt')
        prompt += '\n' + '\n'.join(pending)

    # Generate a session ID for this run
    import uuid
    current_session_id = session_id or str(uuid.uuid4())

    # Query loop
    try:
        while True:
            log(f'Starting query (session: {current_session_id})...')

            query_result = await run_query(agent, prompt, container_input)

            # Save session for potential resume
            save_session(agent.messages)

            # Write output
            write_output({
                'status': 'success',
                'result': query_result['result'],
                'newSessionId': current_session_id,
                'tokenInput': query_result['token_input'] or None,
                'tokenOutput': query_result['token_output'] or None,
            })

            if query_result['closed_during_query']:
                log('Close sentinel consumed during query, exiting')
                break

            # Emit session update
            write_output({
                'status': 'success',
                'result': None,
                'newSessionId': current_session_id,
            })

            log('Query ended, waiting for next IPC message...')
            next_message = await wait_for_ipc_message()
            if next_message is None:
                log('Close sentinel received, exiting')
                break

            log(f'Got new message ({len(next_message)} chars), starting new query')
            prompt = next_message

    except Exception as err:
        log(f'Agent error: {err}')
        write_output({
            'status': 'error',
            'result': None,
            'newSessionId': current_session_id,
            'error': str(err),
        })
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())
