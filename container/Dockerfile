# NanoClaw Agent Container
# Runs Mini-Agent (Python) with MCP tools in isolated Linux VM

FROM node:22-slim

# Install system dependencies for Chromium + Python
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    && pip3 install --break-system-packages cellcog \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser globally (still useful as a bash tool)
RUN npm install -g agent-browser

# Create app directory
WORKDIR /app

# --- Node.js layer: IPC MCP server (kept as-is) ---
COPY agent-runner/package*.json ./
RUN npm install
COPY agent-runner/ ./
RUN npm run build

# --- Python layer: Mini-Agent runner ---
COPY mini-agent-runner/requirements.txt /app/mini-agent/requirements.txt
RUN pip3 install --break-system-packages -r /app/mini-agent/requirements.txt

COPY mini-agent-runner/ /app/mini-agent/

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Reads JSON from stdin, runs Python agent-runner
# IPC MCP server (Node.js) is spawned by the agent as a subprocess
RUN printf '#!/bin/bash\nset -e\n\n# Build IPC MCP server (Node.js)\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\n\n# Add skills directory to Python path\nexport PYTHONPATH=\"/home/node/.claude/skills:${PYTHONPATH:-}\"\n\n# Run Python agent-runner\npython3 /app/mini-agent/agent_runner.py\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
