#!/bin/bash
# Puts the speech and cleanup engines in engines/ so the app ships them and
# users install nothing else.
#   engines/bin/whisperkit-cli: copied from Homebrew (links only macOS libraries)
#   engines/python:             a standalone Python with mlx-lm installed, run
#                               as `python3 -m mlx_lm server`
# MLX stays the cleanup engine: on the same prompts llama.cpp was 1.5-2x slower
# for non-English dictation and its 3B model garbled Hindi.
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON_VERSION=3.11
MLX_LM_VERSION=0.32.2
MLX_VERSION=0.32.4
OUT=engines/bin
PY=engines/python
mkdir -p "$OUT"

if [ ! -x "$PY/bin/python3" ]; then
  # python-build-standalone (via uv) is relocatable, so it runs from inside the app.
  UV_PYTHON_INSTALL_DIR=engines/.uv-python uv python install --quiet "$PYTHON_VERSION"
  src="$(UV_PYTHON_INSTALL_DIR=engines/.uv-python uv python find --no-project "$PYTHON_VERSION" --managed-python)"
  rm -rf "$PY" && cp -R "$(cd "$(dirname "$src")/.." && pwd -P)" "$PY"
  rm -rf engines/.uv-python
  uv pip install --quiet --compile-bytecode --python "$PY/bin/python3" --break-system-packages \
    "mlx-lm==$MLX_LM_VERSION" "mlx==$MLX_VERSION"
  # The server needs none of these: package tools, the Tk GUI, IDLE, C headers, tests.
  site="$PY/lib/python$PYTHON_VERSION"
  rm -rf "$site/site-packages/pip" "$site/site-packages/setuptools" "$site/ensurepip" \
    "$site/idlelib" "$site/tkinter" "$site/test" "$PY"/lib/tcl* "$PY"/lib/tk* "$PY"/lib/itcl* "$PY/include" \
    "$PY/share" "$PY/lib/pkgconfig"
  # codesign rejects the symlinks in bin/, and the app needs only the interpreter.
  mv "$PY/bin/python$PYTHON_VERSION" "$PY/python3"
  rm -rf "$PY/bin" && mkdir "$PY/bin" && mv "$PY/python3" "$PY/bin/python3"
fi

if [ ! -x "$OUT/whisperkit-cli" ]; then
  WK="$(brew --prefix whisperkit-cli 2>/dev/null)/bin/whisperkit-cli"
  if [ ! -x "$WK" ]; then
    echo "whisperkit-cli is needed to build the app: brew install whisperkit-cli" >&2
    exit 1
  fi
  cp "$WK" "$OUT/whisperkit-cli"
  chmod u+w "$OUT/whisperkit-cli"
fi

# whisperkit-cli needs this Swift library, which is built into macOS 26 but
# not older versions. Its rpath checks /usr/lib/swift first, then its own folder.
SPAN=libswiftCompatibilitySpan.dylib
if [ ! -f "$OUT/$SPAN" ]; then
  cp "$(xcode-select -p)/usr/lib/swift-6.2/macosx/$SPAN" "$OUT/$SPAN" 2>/dev/null ||
    cp "/Library/Developer/CommandLineTools/usr/lib/swift-6.2/macosx/$SPAN" "$OUT/$SPAN"
fi

# Refuse to ship a binary that still depends on Homebrew or other local libraries.
for bin in "$OUT"/*; do
  if otool -L "$bin" | tail -n +2 | grep -v -e '/System/Library/' -e '/usr/lib/' -e '@rpath/libswift'; then
    echo "$bin links libraries that won't exist on users' Macs" >&2
    exit 1
  fi
done
if find "$PY" \( -name '*.so' -o -name '*.dylib' \) -exec otool -L {} + | grep -e /opt/homebrew -e /usr/local -e "$HOME"; then
  echo "$PY links libraries that won't exist on users' Macs" >&2
  exit 1
fi
echo "Engines ready in engines/"
