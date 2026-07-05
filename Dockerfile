# pgwen — Playwright-Pgwen framework runtime image
#
# Uses the official Playwright image which bundles all browser binaries and
# their OS-level dependencies. No `npx playwright install` step needed.
#
# Build:
#   docker build -t pgwen .
#
# Run (example — normally invoked via docker-compose):
#   docker run --rm -v $PWD:/project -w /project \
#     -e PROJECT_PROFILE=Example -e PGWEN_ENV=test \
#     pgwen bash -c "npm ci && node dist/cli/launcher.js -p \$PROJECT_PROFILE -b"

# Pin to a specific Playwright version that matches package.json.
# Keep in sync with the "playwright" version in package.json.
ARG PLAYWRIGHT_VERSION=v1.59.1
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}-noble

# Node 22 (Playwright image ships with Node; override if needed)
# The Playwright base image already includes a modern Node LTS.
# Uncomment the block below if you need to pin to Node 22 specifically:
#
# RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
#     apt-get install -y nodejs

WORKDIR /project

# Install dependencies at build time for layer caching (optional — projects
# typically bind-mount the repo, so this is a no-op when $PWD is mounted)
# COPY package*.json ./
# RUN npm ci --ignore-scripts

# Default entrypoint — overridden by docker-compose `command:`
CMD ["bash"]
