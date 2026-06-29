#!/bin/bash

# Quick test a single voice query
# Usage: ./quick-test.sh "your query here" [device-id]

QUERY="$1"
DEVICE="${2:-emulator-5554}"

if [ -z "$QUERY" ]; then
	echo "Usage: $0 \"your query\" [device-id]"
	echo ""
	echo "Examples:"
	echo "  $0 \"best espresso machines\""
	echo "  $0 \"pour over coffee recipes\" emulator-5554"
	exit 1
fi

# Convert spaces to + for URL encoding
ENCODED_QUERY=$(echo "$QUERY" | sed 's/ /+/g')

echo "Testing query: $QUERY"
echo "Device: $DEVICE"
echo ""

# Clear logs
adb -s "$DEVICE" logcat -c

# Send intent
echo "Sending intent..."
adb -s "$DEVICE" shell am start \
	-a android.intent.action.VIEW \
	-d "arco://search?q=$ENCODED_QUERY"

# Wait for processing
sleep 2

# Show relevant logs
echo ""
echo "=== Logs ==="
adb -s "$DEVICE" logcat -d | grep -E "DiscoveryActivity.*(Extracted|Loading|onNewIntent)" | tail -5

echo ""
echo "View full logs: adb -s $DEVICE logcat -s DiscoveryActivity:D"
