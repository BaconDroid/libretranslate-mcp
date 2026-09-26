#!/bin/sh
# Container entrypoint: one foreground process, no argument parsing.
# Defaults are only applied when the variable is not already in the environment,
# so Unraid template variables keep winning.
set -e

: "${TRANSPORT:=http}"
: "${PORT:=8787}"
export TRANSPORT PORT

exec node /app/dist/index.js
