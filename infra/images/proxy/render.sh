#!/bin/sh
# Validate the Seyra ingress access configuration and render the nginx configuration. Fails closed:
# any incomplete or unsafe setting stops here, before nginx exists. Used by the proxy entrypoint and
# by the configuration tests (SEYRA_NGINX_TEMPLATES / SEYRA_NGINX_RUNDIR point at test directories).
#
# Access:  SEYRA_ACCESS_MODE loopback|lan, SEYRA_BIND_ADDR (what compose publishes on),
#          SEYRA_LAN_ALLOW_CIDRS (lan only), SEYRA_SERVER_NAMES.
# Relay:   SEYRA_RELAY_PEER (exact IPv4 of the one relay allowed to connect), SEYRA_RELAY_CLIENT_CIDRS
#          (approved client networks, checked on the address the relay conveys) and
#          SEYRA_RELAY_SERVER_NAMES. All three or none. The relay requires loopback access mode, so
#          the ordinary listener stays a local control path that needs no PROXY header.
set -eu
templates="${SEYRA_NGINX_TEMPLATES:-/etc/seyra}"
rundir="${SEYRA_NGINX_RUNDIR:-/tmp/nginx}"
: "${SEYRA_DATASET_ID:?SEYRA_DATASET_ID is required}"
: "${SEYRA_ACCESS_MODE:=loopback}"
: "${SEYRA_SERVER_NAMES:=localhost 127.0.0.1}"
: "${SEYRA_TILE_CACHE_MAX:=2g}"
: "${SEYRA_RELAY_PEER:=}"
: "${SEYRA_RELAY_CLIENT_CIDRS:=}"
: "${SEYRA_RELAY_SERVER_NAMES:=}"
case "$SEYRA_DATASET_ID" in *[!a-z0-9-]*|"") echo "invalid dataset id" >&2; exit 2;; esac
SEYRA_TEGOLA_MAP="seyra_$(echo "$SEYRA_DATASET_ID" | tr '-' '_')"

fail() { echo "$*; refusing to start (fail closed)" >&2; exit 2; }
# Strict IPv4: four decimal octets 0-255, no leading zeros. Prints the 32-bit value.
ipv4_int() {
  case "$1" in ""|*[!0-9.]*|.*|*.|*..*) return 1;; esac
  _ifs=$IFS; IFS=.; set -- $1; IFS=$_ifs
  [ $# -eq 4 ] || return 1
  _n=0
  for _o in "$@"; do
    case "$_o" in 0[0-9]*|????*) return 1;; esac
    [ "$_o" -le 255 ] || return 1
    _n=$(( _n * 256 + _o ))
  done
  echo "$_n"
}
# Canonical CIDR (host bits zero), prefix 8..32 — broader entries such as 0.0.0.0/0 are refused.
valid_cidr() {
  _ip=${1%/*}; _p=${1#*/}
  [ "$_ip" != "$1" ] || return 1
  case "$_p" in ""|*[!0-9]*|0?*) return 1;; esac
  [ "$_p" -ge 8 ] && [ "$_p" -le 32 ] || return 1
  _v=$(ipv4_int "$_ip") || return 1
  [ $(( _v % (1 << (32 - _p)) )) -eq 0 ]
}
# Is IPv4 address $1 inside canonical CIDR $2?
in_cidr() {
  _a=$(ipv4_int "$1"); _ip=${2%/*}; _p=${2#*/}; _v=$(ipv4_int "$_ip")
  [ $(( _a >> (32 - _p) )) -eq $(( _v >> (32 - _p) )) ]
}
# Validate a comma-separated CIDR list in the main shell ($2 = setting name). Never call fail()
# inside $(...): exit would only leave the subshell.
check_cidrs() {
  case "$1" in ""|,*|*,|*,,*) fail "$2 has an empty entry";; esac
  for _c in $(echo "$1" | tr ',' ' '); do
    valid_cidr "$_c" || fail "invalid CIDR '$_c' in $2 (canonical a.b.c.d/n, n 8-32)"
  done
}
# "allow a/b;" lines for an already validated list, followed by "deny all;".
allow_rules() {
  for _c in $(echo "$1" | tr ',' ' '); do printf '    allow %s;\n' "$_c"; done
  printf '    deny all;'
}
names_ok() { echo "$1" | grep -Eq '^[A-Za-z0-9.-]+( [A-Za-z0-9.-]+)*$'; }

# The published bind address comes from the same variable compose uses for the port binding.
: "${SEYRA_BIND_ADDR:?SEYRA_BIND_ADDR (published bind address) is required}"
bind_int=$(ipv4_int "$SEYRA_BIND_ADDR") || fail "invalid SEYRA_BIND_ADDR '$SEYRA_BIND_ADDR'"
case "$SEYRA_ACCESS_MODE" in
  loopback)
    # Only a loopback publication may rely on the host binding instead of a client allowlist.
    [ $(( bind_int >> 24 )) -eq 127 ] || fail "loopback access mode with non-loopback bind address $SEYRA_BIND_ADDR (use lan mode with SEYRA_LAN_ALLOW_CIDRS)"
    [ -z "${SEYRA_LAN_ALLOW_CIDRS:-}" ] || fail "SEYRA_LAN_ALLOW_CIDRS is only valid in lan mode"
    SEYRA_ACCESS_RULES="    # access mode: loopback (published on $SEYRA_BIND_ADDR only)"
    ;;
  lan)
    [ -n "${SEYRA_LAN_ALLOW_CIDRS:-}" ] || fail "LAN access mode requires SEYRA_LAN_ALLOW_CIDRS"
    [ $(( bind_int >> 24 )) -ne 127 ] || fail "LAN access mode needs a non-loopback bind address"
    check_cidrs "$SEYRA_LAN_ALLOW_CIDRS" SEYRA_LAN_ALLOW_CIDRS
    SEYRA_ACCESS_RULES="$(printf "    # access mode: lan (network control only, not Seyra Authentication)\n%b" "$(allow_rules "$SEYRA_LAN_ALLOW_CIDRS")")"
    ;;
  *) fail "unknown SEYRA_ACCESS_MODE '$SEYRA_ACCESS_MODE'";;
esac
echo "$SEYRA_SERVER_NAMES" | grep -Eq '^[A-Za-z0-9. -]+$' || { echo "invalid SEYRA_SERVER_NAMES" >&2; exit 2; }

mkdir -p "$rundir/conf.d"
rm -f "$rundir/conf.d/relay.conf"
if [ -n "$SEYRA_RELAY_PEER$SEYRA_RELAY_CLIENT_CIDRS$SEYRA_RELAY_SERVER_NAMES" ]; then
  [ -n "$SEYRA_RELAY_PEER" ] && [ -n "$SEYRA_RELAY_CLIENT_CIDRS" ] && [ -n "$SEYRA_RELAY_SERVER_NAMES" ] \
    || fail "a relay needs SEYRA_RELAY_PEER, SEYRA_RELAY_CLIENT_CIDRS and SEYRA_RELAY_SERVER_NAMES together"
  [ "$SEYRA_ACCESS_MODE" = loopback ] || fail "a relay requires loopback access mode (the ordinary listener stays the local control path)"
  peer_int=$(ipv4_int "$SEYRA_RELAY_PEER") || fail "invalid SEYRA_RELAY_PEER '$SEYRA_RELAY_PEER' (one exact IPv4 address)"
  [ "$peer_int" -ne 0 ] && [ "$peer_int" -ne 4294967295 ] || fail "SEYRA_RELAY_PEER must be one host address"
  check_cidrs "$SEYRA_RELAY_CLIENT_CIDRS" SEYRA_RELAY_CLIENT_CIDRS
  relay_rules="$(allow_rules "$SEYRA_RELAY_CLIENT_CIDRS")"
  for c in $(echo "$SEYRA_RELAY_CLIENT_CIDRS" | tr ',' ' '); do
    ! in_cidr "$SEYRA_RELAY_PEER" "$c" || fail "SEYRA_RELAY_PEER $SEYRA_RELAY_PEER lies inside the client allowlist $c; the relay and the clients must be distinct"
  done
  names_ok "$SEYRA_RELAY_SERVER_NAMES" || fail "invalid SEYRA_RELAY_SERVER_NAMES"
  for n in $SEYRA_RELAY_SERVER_NAMES; do
    case "$n" in localhost|localhost.*|127.*|0.*) fail "SEYRA_RELAY_SERVER_NAMES must not contain the loopback name '$n'";; esac
  done
  # Generated, not templated: every value above has been validated.
  cat > "$rundir/conf.d/relay.conf" <<EOF
  # Relay listener. nginx accepts only connections that start with a PROXY protocol header; the
  # peer must be the configured relay (\$realip_remote_addr is the actual socket peer, never the
  # conveyed address), and only then is the conveyed client address checked against the approved
  # networks. Unknown Host names still get 421.
  geo \$realip_remote_addr \$seyra_relay_peer {
    default 0;
    $SEYRA_RELAY_PEER/32 1;
  }

  server {
    listen 8444 proxy_protocol default_server;
    if (\$seyra_relay_peer = 0) { return 403; }
    return 421;
  }

  server {
    listen 8444 proxy_protocol;
    server_name $SEYRA_RELAY_SERVER_NAMES;

    # Only the relay's PROXY header replaces the client address; HTTP forwarding headers never do.
    set_real_ip_from $SEYRA_RELAY_PEER/32;
    real_ip_header proxy_protocol;
    # set_real_ip_from is not a peer firewall: refuse every other socket peer explicitly.
    if (\$seyra_relay_peer = 0) { return 403; }
    # access: relay (network control only, not Seyra Authentication)
$(printf "%b" "$relay_rules")

    include /tmp/nginx/locations.conf;
  }
EOF
fi

export SEYRA_DATASET_ID SEYRA_TEGOLA_MAP SEYRA_ACCESS_RULES SEYRA_SERVER_NAMES SEYRA_TILE_CACHE_MAX
envsubst '${SEYRA_DATASET_ID} ${SEYRA_TEGOLA_MAP} ${SEYRA_ACCESS_RULES} ${SEYRA_SERVER_NAMES} ${SEYRA_TILE_CACHE_MAX}' \
  < "$templates/nginx.conf.template" > "$rundir/nginx.conf"
envsubst '${SEYRA_TEGOLA_MAP}' < "$templates/locations.conf.template" > "$rundir/locations.conf"
