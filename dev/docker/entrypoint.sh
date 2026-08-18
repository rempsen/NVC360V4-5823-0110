#!/bin/sh
set -e

bun install
bun db:push
exec bun dev --host
