#!/bin/bash

# switch the manifest.json between the Chrome, Firefox, and Safari ones
# usage: switch-target.sh [chrome|firefox|safari]

if [[ "$1" == "chrome" ]]; then
  cp -f manifest-chrome.json manifest.json
  echo "Switched to Chrome manifest"
elif [[ "$1" == "firefox" ]]; then
  cp -f manifest-firefox.json manifest.json
  echo "Switched to Firefox manifest"
elif [[ "$1" == "safari" ]]; then
  cp -f manifest-safari.json manifest.json
  echo "Switched to Safari manifest"
else
  echo "Usage: switch-target.sh [chrome|firefox|safari]"
fi