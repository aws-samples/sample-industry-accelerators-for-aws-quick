# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Points the sandbox at temporary directories and the test interpreter before the server module is imported."""

import os
import sys
import tempfile
from pathlib import Path

_ROOT = Path(tempfile.mkdtemp(prefix="code-sandbox-test-"))
os.environ["SANDBOX_WORKDIR"] = str(_ROOT / "workspace")
os.environ["SANDBOX_HOME"] = str(_ROOT / "home")
os.environ["SANDBOX_STATE_DIR"] = str(_ROOT / "state")
os.environ["SANDBOX_PYTHON"] = sys.executable
os.environ["SANDBOX_ENVIRONMENT"] = "chem"
os.environ["SANDBOX_ENVIRONMENT_FILE"] = str(Path(__file__).parent.parent / "environments" / "chem" / "pyproject.toml")
(_ROOT / "workspace").mkdir()
(_ROOT / "home").mkdir()
