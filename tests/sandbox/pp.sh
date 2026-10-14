#!/bin/zsh
# pp.sh METHOD PATH [JSON] — PayPal SANDBOX API call with the local test keys
cd "$(dirname "$0")"
set -a; source <(grep -E '^PAYPAL_' .env.sandbox); set +a
[[ "$PAYPAL_ENV" == sandbox ]] || exit 1
TOK=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials https://api-m.sandbox.paypal.com/v1/oauth2/token | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -X "$1" "https://api-m.sandbox.paypal.com$2" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" ${3:+-d "$3"}
