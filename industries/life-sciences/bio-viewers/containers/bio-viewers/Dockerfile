# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# bio-viewers MCP server (protein structure, sequence alignment and DICOM MCP
# Apps viewers) served over stateless Streamable HTTP for Amazon Bedrock AgentCore
# Runtime. AgentCore Runtime runs linux/arm64 images.
#
# Dependencies come from requirements.txt, exported from uv.lock with hashes
# (`uv export --frozen --no-dev --no-emit-project -o requirements.txt`) and
# installed with --require-hashes. Regenerate it whenever uv.lock changes.

# Base image from the ECR Public Docker Official Images mirror, pinned by digest. Every stage starts from it.
FROM public.ecr.aws/docker/library/python:3.13-slim-trixie@sha256:d3449c0493345868b09708d7056dce5edda3a75233ea86008fc80c934d355a10 AS python-base

FROM python-base AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src
COPY pyproject.toml ./
COPY src ./src
RUN pip wheel --no-deps --wheel-dir /wheels .

FROM python-base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt && rm /tmp/requirements.txt
COPY --from=build /wheels /tmp/wheels
RUN pip install --no-deps /tmp/wheels/*.whl && rm -rf /tmp/wheels \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
USER 10001

# AgentCore Runtime requires the MCP endpoint at 0.0.0.0:8000/mcp. The Runtime
# accepts only SigV4-signed InvokeAgentRuntime calls and never publishes the
# container port, so the wildcard bind is reachable only through the platform.
ENV MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000
EXPOSE 8000
# Docker and Finch use this when you run the image locally; AgentCore Runtime has its own health check
# (`/ping`) and ignores it. Passes in stdio mode, where nothing listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/python", "-c", "import os, socket, sys; sys.exit(0) if os.environ.get('MCP_TRANSPORT') == 'stdio' else socket.create_connection(('127.0.0.1', int(os.environ.get('MCP_PORT', '8000'))), 3).close()"]
CMD ["bio-viewers-mcp"]
