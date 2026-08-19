#!/bin/sh
set -e

bun install
bun db:push

if [ $# -gt 0 ]; then
  exec "$@"
else
  exec bun dev --host
fi
