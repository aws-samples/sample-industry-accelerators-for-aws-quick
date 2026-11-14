# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Code sandbox MCP server for Amazon Bedrock AgentCore Runtime, plus one sandbox environment, selected with the
# ENVIRONMENT build argument (an ID under environments/). AgentCore Runtime runs linux/arm64 images, at most 2 GB.
#
# Two Python environments, both hash-checked:
# - the server: requirements.txt, exported from uv.lock
#   (`uv export --frozen --no-dev --no-emit-project -o requirements.txt`)
# - the sandbox: /opt/sandbox, built in layers. Each env-<id> stage starts from its parent's stage and adds the
#   packages of environments/<id>/requirements.txt (`make lock` resolves it against the parent's lock), so images
#   that share a parent share its image layers, locally and in ECR:
#
#     base -> env-general -> env-chem, env-dicom, env-vcf, env-rnaseq, env-multiomics
#                         -> env-scbase -> env-sctraj
#
# The server goes on top of the selected environment. BuildKit builds only the stages that environment needs.
# Sandboxed code runs with /opt/sandbox/bin/python, which cannot import the server's packages.

# The environment to build (overridden by the CDK image asset for each Runtime).
ARG ENVIRONMENT=chem

# Base image from the ECR Public Docker Official Images mirror, pinned by digest. Every stage starts from it.
FROM public.ecr.aws/docker/library/python:3.13-slim-trixie@sha256:d3449c0493345868b09708d7056dce5edda3a75233ea86008fc80c934d355a10 AS python-base

FROM python-base AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src
COPY pyproject.toml ./
COPY src ./src
RUN pip wheel --no-deps --wheel-dir /wheels .

# Build-time tools (uv and the hash-pinned build backend), bind-mounted into the environment stages at /tools.
FROM python-base AS tools
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY build-requirements.txt install-environment.sh /
RUN pip install --require-hashes --no-deps -r /build-requirements.txt

FROM python-base AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# Root owns the sandbox environment, so sandboxed code cannot change the installed packages. It has no pip.
RUN python -m venv --without-pip /opt/sandbox \
    && useradd --uid 10001 --create-home --home-dir /home/sandbox --shell /bin/bash sandbox \
    && install -d -o 10001 -g 10001 /workspace

# ---------------------------------------------------------------------------------------------------------------------
# Environment layers. Keep one stage per directory under environments/, built on its [tool.code-sandbox] parent.
# They sit below the server, so a server change rebuilds only the small top layers.

FROM base AS env-general
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/general/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

FROM env-general AS env-chem
# RDKit's drawing code (rdkit.Chem.Draw) links against libXrender, libXext and libexpat.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libxrender1 libxext6 libexpat1 \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/chem/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

FROM env-general AS env-dicom
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/dicom/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

FROM env-general AS env-vcf
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/vcf/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

FROM env-general AS env-rnaseq
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/rnaseq/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

FROM env-general AS env-multiomics
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/multiomics/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

# Shared single-cell layer; not deployed on its own.
FROM env-general AS env-scbase
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/scbase/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

FROM env-scbase AS env-sctraj
RUN --mount=type=bind,from=tools,target=/tools \
    --mount=type=bind,source=environments/sctraj/requirements.txt,target=/tmp/requirements.txt \
    /tools/install-environment.sh

# ---------------------------------------------------------------------------------------------------------------------
# The selected environment plus the server: the same server, user and entry point for every environment. The
# server is installed into the system Python, separate from /opt/sandbox.

# checkov:skip=CKV_DOCKER_7: env-${ENVIRONMENT} names one of the env-* stages above, which all build on the digest-pinned python-base stage
FROM env-${ENVIRONMENT}
ARG ENVIRONMENT
COPY requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt && rm /tmp/requirements.txt
COPY --from=build /wheels /tmp/wheels
RUN pip install --no-deps /tmp/wheels/*.whl && rm -rf /tmp/wheels
# Supplies the title and description that get_sandbox_info and the server instructions show.
COPY environments/${ENVIRONMENT}/pyproject.toml /opt/sandbox-environment.toml
USER 10001
WORKDIR /workspace

ENV SANDBOX_ENVIRONMENT=${ENVIRONMENT} \
    SANDBOX_ENVIRONMENT_FILE=/opt/sandbox-environment.toml \
    SANDBOX_PYTHON=/opt/sandbox/bin/python \
    SANDBOX_WORKDIR=/workspace \
    SANDBOX_HOME=/home/sandbox

# AgentCore Runtime requires the MCP endpoint at 0.0.0.0:8000/mcp. The Runtime accepts only SigV4-signed
# InvokeAgentRuntime calls and never publishes the container port, so the wildcard bind is reachable only through
# the platform.
ENV MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000
EXPOSE 8000
# Docker and Finch use this when you run the image locally; AgentCore Runtime has its own health check
# (`/ping`) and ignores it. Passes in stdio mode, where nothing listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/python", "-c", "import os, socket, sys; sys.exit(0) if os.environ.get('MCP_TRANSPORT') == 'stdio' else socket.create_connection(('127.0.0.1', int(os.environ.get('MCP_PORT', '8000'))), 3).close()"]
CMD ["code-sandbox-mcp"]
