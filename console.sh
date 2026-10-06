#!/bin/sh
# Linux/macOS entrypoint: runs console.py with the first Python 3.7+ found.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
for python in python3 python; do
  if command -v "$python" >/dev/null 2>&1 &&
    "$python" -c 'import sys; sys.exit(sys.version_info < (3, 7))' >/dev/null 2>&1; then
    exec "$python" "$dir/console.py" "$@"
  fi
done
echo "[ERROR] Python 3.7 ou mais novo não encontrado (python3)." >&2
echo "        Debian/Raspberry Pi OS: sudo apt install python3    macOS: xcode-select --install" >&2
exit 1
