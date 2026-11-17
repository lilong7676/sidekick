#!/bin/sh
# Stands in for slackcli in tests: answers after a second, like a slow Slack call.
sleep 1
echo '{"ok":true}'
