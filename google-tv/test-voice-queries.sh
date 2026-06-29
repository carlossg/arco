#!/bin/bash

# Arco Voice Command Test Script
# Tests various queries that would normally come from Google Assistant

set -e

# Configuration
DEVICE_ID="${1:-emulator-5554}"
PACKAGE="com.arco.tv"
ACTIVITY="$PACKAGE/.ui.DiscoveryActivity"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test queries array
declare -a queries=(
	"best+espresso+machines"
	"pour+over+coffee+recipes"
	"beginner+coffee+gear"
	"best+grinder+for+espresso"
	"single+origin+ethiopian+beans"
	"arco+espresso+lineup"
	"how+to+make+a+flat+white"
	"cold+brew+recipes"
	"best+coffee+for+milk+drinks"
	"french+press+brewing+guide"
)

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Arco Voice Command Testing${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Device: ${GREEN}$DEVICE_ID${NC}"
echo -e "Package: ${GREEN}$PACKAGE${NC}"
echo ""

# Check if device is connected
if ! adb -s "$DEVICE_ID" get-state >/dev/null 2>&1; then
	echo -e "${RED}Error: Device $DEVICE_ID not found${NC}"
	echo "Available devices:"
	adb devices
	exit 1
fi

# Check if app is installed
if ! adb -s "$DEVICE_ID" shell pm list packages | grep -q "$PACKAGE"; then
	echo -e "${RED}Error: App $PACKAGE not installed${NC}"
	echo "Install it first with:"
	echo "  ./gradlew assembleDebug && adb -s $DEVICE_ID install app/build/outputs/apk/debug/app-debug.apk"
	exit 1
fi

echo -e "${GREEN}✓ Device connected${NC}"
echo -e "${GREEN}✓ App installed${NC}"
echo ""

# Option to clear logs (with timeout for automation)
if [ -t 0 ]; then
	read -p "Clear logs before testing? (y/n) " -n 1 -r -t 5
	echo
	if [[ $REPLY =~ ^[Yy]$ ]]; then
		adb -s "$DEVICE_ID" logcat -c
		echo -e "${GREEN}✓ Logs cleared${NC}"
	fi
else
	# Non-interactive mode, skip
	echo "Running in non-interactive mode, skipping log clear"
fi

echo ""
echo -e "${BLUE}Testing ${#queries[@]} queries...${NC}"
echo ""

# Test each query
for i in "${!queries[@]}"; do
	query="${queries[$i]}"
	query_display=$(echo "$query" | sed 's/+/ /g')
	
	echo -e "${YELLOW}[$((i+1))/${#queries[@]}]${NC} Testing: ${GREEN}$query_display${NC}"
	
	# Send intent
	adb -s "$DEVICE_ID" shell am start \
		-a android.intent.action.VIEW \
		-d "arco://search?q=$query" \
		>/dev/null 2>&1
	
	# Wait a moment for app to process
	sleep 1
	
	# Check logs for confirmation
	if adb -s "$DEVICE_ID" logcat -d | grep -q "Extracted query: ${query_display}"; then
		echo -e "  ${GREEN}✓ Query extracted successfully${NC}"
	else
		echo -e "  ${RED}✗ Query extraction not confirmed in logs${NC}"
	fi
	
	# Check if correct URL was loaded
	if adb -s "$DEVICE_ID" logcat -d | grep -q "Loading URL.*q=$query"; then
		echo -e "  ${GREEN}✓ URL loaded with query parameter${NC}"
	else
		echo -e "  ${YELLOW}⚠ URL loading not confirmed${NC}"
	fi
	
	echo ""
	
	# Small delay between tests
	sleep 2
done

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Testing Complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "View full logs with:"
echo "  adb -s $DEVICE_ID logcat -s DiscoveryActivity:D"
echo ""
echo "Test a specific query manually:"
echo "  adb -s $DEVICE_ID shell am start -a android.intent.action.VIEW -d \"arco://search?q=YOUR+QUERY\""
