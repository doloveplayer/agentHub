FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @anthropic-ai/claude-agent-sdk
RUN npm install -g zod

# Use non-root user for --dangerously-skip-permissions compatibility
RUN mkdir -p /workspace \
    && mkdir -p /home/node/.claude/sessions \
    && chown -R node:node /workspace /home/node/.claude

# SDK runner script — executed via docker exec for in-container SDK usage
COPY sdk-runner.mjs /usr/local/bin/sdk-runner.mjs
RUN chmod +x /usr/local/bin/sdk-runner.mjs

# planGen — standardized plan.json generator called by Planner agent
COPY planGen.mjs /usr/local/bin/planGen.mjs
RUN chmod +x /usr/local/bin/planGen.mjs

USER node

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
