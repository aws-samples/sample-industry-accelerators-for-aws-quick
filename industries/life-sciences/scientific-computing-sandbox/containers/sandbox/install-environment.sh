#!/bin/sh
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Installs one environment layer into /opt/sandbox during the image build. The Dockerfile bind-mounts the `tools`
# stage at /tools and the layer's requirements.txt at /tmp/requirements.txt, so neither uv nor the build backend
# stays in the image.
#
# The requirements file is the layer's full lock, which repeats every pin of its parent layers: uv skips the
# distributions the parent stage already installed, so this stage's image layer holds only the new packages.
# Every distribution is hash-checked, and so is the build backend of the few packages that are published only as
# source distributions (build-requirements.txt is passed as build constraints).
set -eu

/tools/usr/local/bin/uv pip install \
    --python /opt/sandbox/bin/python \
    --require-hashes \
    --no-deps \
    --build-constraints /tools/build-requirements.txt \
    --no-cache \
    --link-mode copy \
    --no-python-downloads \
    --quiet \
    -r /tmp/requirements.txt

# Precompile the new modules; compileall leaves the parent layers' up-to-date .pyc files untouched.
/opt/sandbox/bin/python -m compileall -q /opt/sandbox/lib
