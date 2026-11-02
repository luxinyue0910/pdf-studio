#!/bin/zsh
set -e
cd "${0:A:h}"
if [[ ! -x .env/bin/python ]]; then
  echo "Install Python and the dependencies using the instructions in README.md first."
  read -r '?Press Enter to close'
  exit 1
fi
.env/bin/python app.py
