#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
exec node src/server.mjs "${1:-7999}"
