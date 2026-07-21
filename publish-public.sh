#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
python3 Scripts/publish-public.py --init-git --force "$@"
