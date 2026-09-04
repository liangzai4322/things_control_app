#!/usr/bin/env python3
"""Mac-side conversation runner adapter; Codex transport is injected, never hard-coded."""
import os, subprocess, sys

def run_once():
    # The authenticated client/transport is intentionally supplied by deployment.
    # No HQ/TaskBox credential or desktop thread ID is accepted here.
    command = os.environ.get('ASSISTANT_CONVERSATION_ADAPTER')
    if not command:
        return 2
    return subprocess.call(command, shell=True)

if __name__ == '__main__':
    sys.exit(run_once())
