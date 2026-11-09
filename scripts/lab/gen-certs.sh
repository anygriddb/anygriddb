#!/usr/bin/env bash
# Generate a local CA + server cert for the sample lab (SAN: localhost, 127.0.0.1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/docker/lab/certs"
mkdir -p "$DIR"
cd "$DIR"
if [[ -f ca.crt && -f server.crt && -f server.key ]]; then
  echo "certs already present in $DIR"
  exit 0
fi
openssl genrsa -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt \
  -subj "/CN=AnyGridDB Lab CA"
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr \
  -subj "/CN=localhost"
cat > ext.cnf <<'EOF'
subjectAltName = DNS:localhost,IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 -extfile ext.cnf
chmod 600 server.key
rm -f server.csr ca.srl ext.cnf
echo "Wrote $DIR/{ca.crt,server.crt,server.key}"
