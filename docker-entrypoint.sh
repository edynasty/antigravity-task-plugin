#!/bin/sh
set -e

# The host proxy usually listens on 127.0.0.1, which inside the container
# points at the container itself. Rewrite loopback to host.docker.internal
# (resolved by extra_hosts / Docker Desktop) so agy can reach the host proxy.
if [ -n "$HTTP_PROXY" ]; then
  export HTTP_PROXY=$(printf '%s' "$HTTP_PROXY" | sed 's/127\.0\.0\.1/host.docker.internal/g; s/localhost/host.docker.internal/g')
fi
if [ -n "$HTTPS_PROXY" ]; then
  export HTTPS_PROXY=$(printf '%s' "$HTTPS_PROXY" | sed 's/127\.0\.0\.1/host.docker.internal/g; s/localhost/host.docker.internal/g')
fi

# Container agy (Linux build) reads its OAuth token from
# $HOME/.gemini/antigravity-cli/antigravity-oauth-token, while the macOS host
# login lives at $HOME/.gemini/jetski-standalone-oauth-token (same JSON
# layout: {"token": {access_token, token_type, refresh_token, expiry},
# "auth_method": "..."}). On a fresh bind mount the container file does not
# exist, so agy reports "authentication failed or timed out". Seed it once
# from the host file; agy refreshes the access_token itself afterwards.
if [ ! -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] &&
   [ -f "$HOME/.gemini/jetski-standalone-oauth-token" ]; then
  mkdir -p "$HOME/.gemini/antigravity-cli"
  cp "$HOME/.gemini/jetski-standalone-oauth-token" "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
  chmod 600 "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
fi

exec "$@"
