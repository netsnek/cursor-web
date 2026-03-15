#!/bin/bash
exec node /opt/cursor-web/out/server-main.js \
  --host 0.0.0.0 --port 20000 \
  --without-connection-token \
  /home/coder
