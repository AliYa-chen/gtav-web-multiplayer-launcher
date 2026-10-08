#!/bin/bash
# Maintainer-only packaging. The distributed launcher does not run this script.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage:
  ./sign-macos.sh --app PATH.app --identity 'Developer ID Application: ... (TEAMID)' \
    --keychain-profile PROFILE [--output PATH.zip] [--dry-run]
  ./sign-macos.sh --development --app PATH.app \
    --identity 'Apple Development: ... (TEAMID)' [--output PATH-development.zip] [--dry-run]
  ./sign-macos.sh --development --app PATH.app --identity - [--dry-run]

Public distribution requires Developer ID Application and an existing notarytool
keychain profile. Credentials are never accepted as script arguments. Only after
notarization, stapling and Gatekeeper assessment succeed is the release ZIP saved.

--development creates a clearly named test ZIP without public distribution claims.
An identity of '-' is ad hoc signing and is permitted only with --development.
--dry-run validates arguments and prints the operations; it does not sign or submit.
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
show() { printf '  '; printf '%q ' "$@"; printf '\n'; }

app=''
identity=''
profile=''
output=''
development=0
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app|--identity|--keychain-profile|--output)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      [ -n "$2" ] || fail "$1 requires a nonempty value"
      case "$1" in
        --app) app=$2 ;;
        --identity) identity=$2 ;;
        --keychain-profile) profile=$2 ;;
        --output) output=$2 ;;
      esac
      shift 2 ;;
    --development) development=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$app" ] || fail '--app is required'
[ -n "$identity" ] || fail '--identity is required'
case "$app" in *.app|*.app/) ;; *) fail '--app must be an .app directory' ;; esac
[ -d "$app/Contents" ] || fail 'app bundle is missing Contents'
[ -f "$app/Contents/Info.plist" ] || fail 'app bundle is missing Info.plist'
app=$(cd "$app" && pwd -P)

if [ "$development" -eq 1 ]; then
  [ -z "$profile" ] || fail '--keychain-profile is only used for public distribution'
  case "$identity" in
    -|'Apple Development: '*|'Mac Developer: '*) ;;
    *) fail 'development identity must be Apple Development, Mac Developer, or - (ad hoc)' ;;
  esac
  output=${output:-"$(dirname "$0")/releases/GTA5Data-Launcher-macos-development.zip"}
  case "$output" in *-development.zip) ;; *) fail 'development output must end with -development.zip' ;; esac
else
  case "$identity" in
    'Developer ID Application: '*) ;;
    *) fail 'public distribution requires a Developer ID Application identity' ;;
  esac
  [ -n "$profile" ] || fail 'public distribution requires --keychain-profile'
  output=${output:-"$(dirname "$0")/releases/GTA5Data-Launcher-macos-notarized.zip"}
  case "$output" in *.zip) ;; *) fail 'output must be a .zip file' ;; esac
fi

[ ! -e "$output" ] || fail "output already exists; choose a new path: $output"
case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
case "$output" in "$app"/*) fail 'output must be outside the app bundle' ;; esac

# Dry runs intentionally do not require installed signing identities or credentials.
# They cannot be used as proof that a build was signed, notarized or accepted.
if [ "$dry_run" -eq 1 ]; then
  if [ "$development" -eq 1 ]; then
    printf 'DEVELOPMENT dry run; Gatekeeper/public distribution is not asserted.\n'
  else
    printf 'PUBLIC DISTRIBUTION dry run; no signed/notarized artifact is created.\n'
  fi
  printf 'Copy app to a private temporary staging directory; sign nested code inside out.\n'
  if [ "$identity" = '-' ]; then
    show codesign --force --sign "$identity" --options runtime '<staged code / app>'
  else
    show codesign --force --sign "$identity" --options runtime --timestamp '<staged code / app>'
  fi
  show codesign --verify --deep --strict --verbose=2 '<staged app>'
  if [ "$development" -eq 0 ]; then
    show ditto -c -k --sequesterRsrc --keepParent '<staged app>' '<submission.zip>'
    show xcrun notarytool submit '<submission.zip>' --keychain-profile "$profile" --wait --output-format json
    printf 'Require notarization status Accepted.\n'
    show xcrun stapler staple '<staged app>'
    show xcrun stapler validate '<staged app>'
    show codesign --verify --deep --strict --verbose=2 '<staged app>'
    show spctl --assess --type execute --verbose=4 '<staged app>'
  fi
  show ditto -c -k --sequesterRsrc --keepParent '<staged app>' "$output"
  exit 0
fi

[ "$(uname -s)" = Darwin ] || fail 'actual signing must run on macOS'
for command in codesign security ditto file find plutil; do
  command -v "$command" >/dev/null || fail "required tool is missing: $command"
done
if [ "$development" -eq 0 ]; then
  command -v xcrun >/dev/null || fail 'Xcode Command Line Tools are required'
  command -v spctl >/dev/null || fail 'spctl is required'
  xcrun --find notarytool >/dev/null || fail 'notarytool is unavailable'
  xcrun --find stapler >/dev/null || fail 'stapler is unavailable'
fi

signing_id=$identity
if [ "$identity" != '-' ]; then
  # Require the exact certificate name and an available private key. Signing by the
  # resolved SHA-1 avoids codesign selecting a different similarly named identity.
  identities=$(security find-identity -v -p codesigning) || fail 'cannot read signing identities'
  found=''
  matches=0
  while IFS= read -r line; do
    if [[ "$line" =~ [[:space:]]([0-9A-Fa-f]{40})[[:space:]]+\"(.*)\" ]]; then
      if [ "${BASH_REMATCH[2]}" = "$identity" ]; then
        found=${BASH_REMATCH[1]}
        matches=$((matches + 1))
      fi
    fi
  done <<< "$identities"
  [ "$matches" -eq 1 ] || fail 'expected exactly one valid identity/private key with the exact requested name'
  signing_id=$found
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/gta5data-sign.XXXXXX")
trap 'rm -rf "$stage"' EXIT
staged_app="$stage/$(basename "$app")"
ditto "$app" "$staged_app"

sign_code() {
  if [ "$identity" = '-' ]; then
    codesign --force --sign "$signing_id" --options runtime "$1"
  else
    codesign --force --sign "$signing_id" --options runtime --timestamp "$1"
  fi
}

# Do not use --deep for signing: visit actual nested code before its containing
# bundle, then sign the outer app. --deep is used only for verification.
while IFS= read -r -d '' path; do
  if [ -f "$path" ]; then
    kind=$(file -b "$path")
    case "$kind" in *Mach-O*) sign_code "$path" ;; esac
  elif [ -d "$path" ]; then
    case "$path" in *.framework|*.xpc|*.appex|*.app) sign_code "$path" ;; esac
  fi
done < <(find "$staged_app" -depth \( -type f -o -type d \) -print0)

codesign --verify --deep --strict --verbose=2 "$staged_app"
if [ "$development" -eq 0 ]; then
  ditto -c -k --sequesterRsrc --keepParent "$staged_app" "$stage/submission.zip"
  xcrun notarytool submit "$stage/submission.zip" --keychain-profile "$profile" \
    --wait --output-format json > "$stage/notarization.json"
  status=$(plutil -extract status raw -o - "$stage/notarization.json")
  if [ "$status" != Accepted ]; then
    submission_id=$(plutil -extract id raw -o - "$stage/notarization.json" 2>/dev/null || true)
    printf 'Notarization did not succeed (status: %s; submission: %s). No release ZIP was created.\n' \
      "$status" "$submission_id" >&2
    exit 1
  fi
  xcrun stapler staple "$staged_app"
  xcrun stapler validate "$staged_app"
  codesign --verify --deep --strict --verbose=2 "$staged_app"
  spctl --assess --type execute --verbose=4 "$staged_app"
fi

# Publish only the completed artifact. The source app is never modified.
ditto -c -k --sequesterRsrc --keepParent "$staged_app" "$stage/completed.zip"
mkdir -p "$(dirname "$output")"
[ ! -e "$output" ] || fail 'output appeared during signing; refusing to overwrite it'
mv "$stage/completed.zip" "$output"
if [ "$development" -eq 1 ]; then
  printf 'Development test ZIP: %s\nThis build is not notarized or approved for public distribution.\n' "$output"
else
  printf 'Developer ID signed, notarized and Gatekeeper accepted ZIP: %s\n' "$output"
fi
