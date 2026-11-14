#!/usr/bin/env bash
# Builds aws/arom-api-lambda.zip: the Lambda entry + the existing /api handlers. Run from the repo root: bash aws/build-lambda.sh
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf aws/.build aws/arom-api-lambda.zip && mkdir -p aws/.build/api
cp aws/lambda/index.js aws/.build/
cp api/candles.js api/live.js api/quotes.js api/news.js api/market-news.js aws/.build/api/
(cd aws/.build && zip -qr ../arom-api-lambda.zip .)
rm -rf aws/.build
echo "Built aws/arom-api-lambda.zip"
