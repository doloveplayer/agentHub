FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Use non-root user for --dangerously-skip-permissions compatibility
RUN mkdir -p /workspace \
    && chown node:node /workspace
USER node

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
