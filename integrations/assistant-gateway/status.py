#!/usr/bin/env python3
"""Print the sanitized Assistant Gateway operational status."""

import json
import os
from pathlib import Path

from worker import GatewayStatus


path = Path(os.environ.get(
    "ASSISTANT_GATEWAY_STATUS_FILE",
    "/var/lib/taskbox-assistant-gateway/status.json",
))
print(json.dumps(GatewayStatus(path).snapshot(), ensure_ascii=False, separators=(",", ":")))
